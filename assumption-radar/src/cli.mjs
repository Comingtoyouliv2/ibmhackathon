#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fetchOpenPullRequests, parseRepository } from "./github.mjs";
import { partitionEligiblePullRequests } from "./pr-eligibility.mjs";
import { finishAnalysis } from "./analyzer.mjs";
import { analyzeWithAI, semanticJudgeProvider } from "./ai.mjs";
import { prepareAnalysisPipeline } from "./pipeline.mjs";
import { AI_JUDGMENT_PROTOCOL_VERSION, semanticJudgeRepeatCount } from "./semantic-judge.mjs";
import { DockerCombinedVerifier, loadVerificationProfiles } from "./docker-verifier.mjs";
import { GitMergeTreePreflight } from "./preflight.mjs";
import {
  appendVerificationRecords,
  applyVerificationResults,
  selectVerificationCandidates,
  verificationCaseRecord,
} from "./verification.mjs";

const APP_VERSION = "1.0.0";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const positional = args.find((arg, index) => !arg.startsWith("-") && (index === 0 || !args[index - 1].startsWith("--")));

function help() {
  console.log(`Assumption Radar CLI

Usage:
  npm run scan -- owner/repository [--limit 20] [--preflight] [--ai] [--ai-provider openai|anthropic|codex] [--ai-repeats 3]
    [--verify] [--verify-limit 3] [--verification-profile profiles.json] [--verification-output cases.jsonl]
    [--json] [--fail-on conflict]
  npm run scan -- --demo [--json]

Environment:
  GITHUB_TOKEN     private repository access / higher API limits
  OPENAI_API_KEY   enables --ai
  ANTHROPIC_API_KEY enables --ai with --ai-provider anthropic
  CODEX_MODEL      defaults to gpt-5.4 for --ai-provider codex
  OPENAI_MODEL     defaults to gpt-5.6-terra
  ANTHROPIC_MODEL  defaults to claude-opus-4-8
  AI_JUDGE_REPEATS defaults to 3; every repeated judgment must agree before an AI candidate is stable

Verification:
  --verify runs Base/A/B/A+B in Docker and automatically enables --preflight.
  Draft PRs and PRs with failed GitHub CI are excluded before execution; pending or unknown checks remain eligible.
  Automatic profiles support package-lock.json, pnpm-lock.yaml, yarn.lock, and Python projects.`);
}

function printReport(result, repository) {
  console.log(`\nASSUMPTION RADAR · ${repository}`);
  console.log(`${"─".repeat(68)}`);
  console.log(`${result.summary.prCount} open PR · ${result.summary.pairCount} pairs · ${result.summary.conflictCount} conflicts · ${result.summary.reviewCount} reviews`);
  if (result.prEligibility) {
    console.log(`Eligibility: ${result.prEligibility.eligible}/${result.prEligibility.fetched} PR · ${result.prEligibility.excluded} draft/failed-CI excluded`);
  }
  if (result.summary.verifiedPairCount) {
    console.log(`${result.summary.verifiedPairCount} verified · ${result.summary.confirmedConflictCount} confirmed pair regressions · ${result.summary.verifiedCompatibleCount} no observed regressions`);
  }
  console.log(`Verdict: ${result.summary.verdict}\n`);
  for (const conflict of result.findings) {
    const prs = conflict.prIds.map((id) => `#${result.prs.find((pr) => pr.id === id)?.number || id}`).join(" × ");
    console.log(`[${conflict.verdict.toUpperCase()} · ${conflict.basis}] ${prs}  ${conflict.title}`);
    console.log(`  ${conflict.summary}`);
    console.log(`  → ${conflict.recommendation}\n`);
  }
  if (result.verificationErrors?.length) {
    console.log(`Verification errors: ${result.verificationErrors.length}`);
    for (const error of result.verificationErrors.slice(0, 5)) console.log(`  ${error.key}: ${error.error}`);
  }
  if (result.verificationOutput) console.log(`Verification JSONL: ${result.verificationOutput}`);
}

async function main() {
  if (has("--help") || has("-h")) return help();
  const useVerification = has("--verify");
  let prs;
  let repository;
  let prEligibility = null;
  if (has("--demo")) {
    const demoPath = fileURLToPath(new URL("../demo/synthetic-prs.json", import.meta.url));
    prs = JSON.parse(await readFile(demoPath, "utf8"));
    repository = "acme/commerce (demo)";
  } else {
    if (!positional) throw new Error("Enter owner/repository or use --demo.");
    repository = parseRepository(positional);
    const limit = Math.max(2, Math.min(100, Number(value("--limit")) || 20));
    const fetched = await fetchOpenPullRequests(repository, process.env.GITHUB_TOKEN, { limit, includeCiStatus: useVerification });
    if (useVerification) {
      const partitioned = partitionEligiblePullRequests(fetched);
      prs = partitioned.eligible;
      prEligibility = { ...partitioned.summary, excludedPullRequests: partitioned.excluded };
    } else prs = fetched;
  }
  if (prs.length < 2) throw new Error("At least two open PRs are required for analysis.");
  if (useVerification && has("--demo")) throw new Error("--verify is available only for a real GitHub repository.");
  const preflightEngine = useVerification ? new GitMergeTreePreflight(repository) : null;
  const pipeline = await prepareAnalysisPipeline(prs, {
    repository: has("--demo") ? null : repository,
    useMergePreflight: has("--preflight") || useVerification,
    ...(preflightEngine ? { preflightEngine } : {}),
  });
  const prepared = pipeline.prepared;
  const aiOptions = {
    aiProvider: value("--ai-provider"),
    aiRepeats: value("--ai-repeats") ?? process.env.AI_JUDGE_REPEATS,
  };
  const aiConflicts = has("--ai") ? await analyzeWithAI(prepared, aiOptions) : [];
  let result = {
    ...finishAnalysis(prepared, aiConflicts),
    repository,
    mode: aiConflicts.length ? "ai+heuristic" : "heuristic",
    analysisProtocol: {
      deterministicRuns: 1,
      aiProtocolVersion: has("--ai") ? AI_JUDGMENT_PROTOCOL_VERSION : null,
      aiRepeats: has("--ai") ? semanticJudgeRepeatCount(aiOptions) : 0,
      unanimityRequired: has("--ai"),
    },
    preflight: pipeline.preflight,
    ...(prEligibility ? { prEligibility } : {}),
  };
  if (useVerification) {
    const profiles = await loadVerificationProfiles(value("--verification-profile"));
    const candidates = selectVerificationCandidates(prepared, result, { limit: Math.max(1, Number(value("--verify-limit")) || 3) });
    const verifier = new DockerCombinedVerifier(repository, { preflightEngine, profiles });
    try {
      const verified = await verifier.verify(prepared, candidates);
      const beforeExecution = result;
      result = applyVerificationResults(result, verified.verifications);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const defaultOutput = fileURLToPath(new URL(`../.cache/verification-runs/${repository.replaceAll("/", "__")}-${timestamp}.jsonl`, import.meta.url));
      const output = value("--verification-output") || defaultOutput;
      const findings = new Map((beforeExecution.findings || []).map((item) => [[...item.prIds].sort().join(":"), item]));
      const records = verified.verifications.map((verification) => verificationCaseRecord({
        repository,
        verification,
        finding: findings.get([...verification.prIds].sort().join(":")),
        metadata: {
          analyzerVersion: APP_VERSION,
          promptVersion: has("--ai") ? "interaction-hypothesis-v0.5" : null,
          model: has("--ai") ? (() => {
            const provider = semanticJudgeProvider(aiOptions);
            if (provider === "anthropic") return process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
            if (provider === "codex") return process.env.CODEX_MODEL || "gpt-5.4";
            return process.env.OPENAI_MODEL || "gpt-5.6-terra";
          })() : null,
        },
      }));
      await appendVerificationRecords(output, records);
      result = { ...result, verificationErrors: verified.errors, verificationOutput: records.length ? output : null };
    } catch (error) {
      result = { ...result, verificationError: error.message, verificationErrors: [{ key: "runner", error: error.message }] };
    }
  }
  if (has("--json")) console.log(JSON.stringify(result, null, 2));
  else printReport(result, repository);

  const threshold = value("--fail-on");
  if (threshold && !["conflict", "review"].includes(threshold)) throw new Error("--fail-on must be conflict or review.");
  if (threshold === "conflict" && result.findings.some((item) => item.verdict === "conflict")) process.exitCode = 2;
  if (threshold === "review" && result.findings.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`Assumption Radar: ${error.message}`);
  process.exitCode = 1;
});
