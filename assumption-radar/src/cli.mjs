#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fetchOpenPullRequests, parseRepository } from "./github.mjs";
import { finishAnalysis } from "./analyzer.mjs";
import { analyzeWithAI, semanticJudgeProvider } from "./ai.mjs";
import { prepareAnalysisPipeline } from "./pipeline.mjs";
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
  npm run scan -- owner/repository [--limit 20] [--preflight] [--ai] [--ai-provider openai|anthropic|codex]
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

Verification:
  --verify는 Docker에서 Base/A/B/A+B를 실행하며 --preflight를 자동 활성화합니다.
  자동 프로필은 package-lock.json, pnpm-lock.yaml, yarn.lock, Python 프로젝트를 지원합니다.`);
}

function printReport(result, repository) {
  console.log(`\nASSUMPTION RADAR · ${repository}`);
  console.log(`${"─".repeat(68)}`);
  console.log(`${result.summary.prCount} open PR · ${result.summary.pairCount} pairs · ${result.summary.conflictCount} conflicts · ${result.summary.reviewCount} reviews`);
  if (result.summary.aiReviewedPairCount !== undefined) {
    console.log(`${result.summary.aiReviewedPairCount} AI-reviewed · ${result.summary.noAlertUnreviewedCount} no-alert/unreviewed · ${result.summary.staticCandidateUnreviewedCount} static candidates awaiting review · ${result.summary.insufficientEvidenceCount} insufficient`);
  }
  if (result.summary.verifiedPairCount) {
    console.log(`${result.summary.verifiedPairCount} verified · ${result.summary.confirmedConflictCount} confirmed pair regressions · ${result.summary.verifiedCompatibleCount} no observed regression`);
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
  let prs;
  let repository;
  if (has("--demo")) {
    const demoPath = fileURLToPath(new URL("../demo/synthetic-prs.json", import.meta.url));
    prs = JSON.parse(await readFile(demoPath, "utf8"));
    repository = "acme/commerce (demo)";
  } else {
    if (!positional) throw new Error("owner/repository를 입력하거나 --demo를 사용하세요.");
    repository = parseRepository(positional);
    const limit = Math.max(2, Math.min(100, Number(value("--limit")) || 20));
    prs = await fetchOpenPullRequests(repository, process.env.GITHUB_TOKEN, { limit });
  }
  if (prs.length < 2) throw new Error("분석할 open PR이 2개 이상 필요합니다.");
  const useVerification = has("--verify");
  if (useVerification && has("--demo")) throw new Error("--verify는 실제 GitHub repository에서만 사용할 수 있습니다.");
  const preflightEngine = useVerification ? new GitMergeTreePreflight(repository) : null;
  const pipeline = await prepareAnalysisPipeline(prs, {
    repository: has("--demo") ? null : repository,
    useMergePreflight: has("--preflight") || useVerification,
    ...(preflightEngine ? { preflightEngine } : {}),
  });
  const prepared = pipeline.prepared;
  const aiOptions = { aiProvider: value("--ai-provider") };
  const aiConflicts = has("--ai") ? await analyzeWithAI(prepared, aiOptions) : [];
  let result = { ...finishAnalysis(prepared, aiConflicts), repository, mode: aiConflicts.length ? "ai+heuristic" : "heuristic", preflight: pipeline.preflight };
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
          promptVersion: has("--ai") ? "semantic-judge-v0.2" : null,
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
  if (threshold && !["conflict", "review"].includes(threshold)) throw new Error("--fail-on은 conflict 또는 review여야 합니다.");
  if (threshold === "conflict" && result.findings.some((item) => item.verdict === "conflict")) process.exitCode = 2;
  if (threshold === "review" && result.findings.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`Assumption Radar: ${error.message}`);
  process.exitCode = 1;
});
