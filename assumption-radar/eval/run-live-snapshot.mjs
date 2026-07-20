#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOpenPullRequests, parseRepository } from "../src/github.mjs";
import { finishAnalysis } from "../src/analyzer.mjs";
import { analyzeWithAI, semanticJudgeProvider } from "../src/ai.mjs";
import { prepareAnalysisPipeline } from "../src/pipeline.mjs";
import { compareLiveSnapshots, stableHash } from "./performance-utils.mjs";
import { selectExplorationControls } from "./live-exploration.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const repository = parseRepository(args.find((argument) => !argument.startsWith("-")));
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const limit = Math.max(2, Math.min(100, Number(value("--limit", 20))));
const explorationLimit = Math.max(0, Math.min(50, Number(value("--exploration-controls", 4))));
const outputRoot = resolve(value("--output-root", join(ROOT, ".cache", "live-snapshots")));

function modelName(aiProvider) {
  if (!has("--ai")) return null;
  if (aiProvider === "anthropic") return process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
  if (aiProvider === "codex") return process.env.CODEX_MODEL || "gpt-5.4";
  return process.env.OPENAI_MODEL || "gpt-5.6-terra";
}

async function latestSnapshot(repoRoot) {
  try {
    const names = (await readdir(repoRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of names) {
      try { return JSON.parse(await readFile(join(repoRoot, name, "snapshot.json"), "utf8")); }
      catch { /* Ignore incomplete snapshots. */ }
    }
  } catch { /* First snapshot. */ }
  return null;
}

function normalizeFinding(finding, prsById) {
  const prs = finding.prIds.map((id) => prsById.get(String(id))).filter(Boolean).sort((a, b) => a.number - b.number);
  const prNumbers = prs.map((pr) => pr.number);
  const input = prs.map((pr) => ({ number: pr.number, headSha: pr.headSha, base: pr.base, baseSha: pr.baseSha }));
  const evidence = finding.evidenceObjects || finding.evidence || [];
  return {
    logicalKey: `${repository}#${prNumbers.join(":")}`,
    prNumbers,
    urls: prs.map((pr) => pr.url),
    verdict: finding.verdict,
    basis: finding.basis,
    source: finding.source,
    title: finding.title,
    summary: finding.summary,
    evidence,
    inputFingerprint: stableHash(input),
    findingFingerprint: stableHash({ verdict: finding.verdict, basis: finding.basis, title: finding.title, summary: finding.summary, evidence }),
  };
}

function findingLines(items) {
  return items.length ? items.map((item) => {
    const finding = item.current || item;
    const numbers = finding.prNumbers?.map((number) => `#${number}`).join(" × ") || item.logicalKey;
    return `| ${numbers} | ${finding.verdict || `${item.previous.verdict} → ${item.current.verdict}`} | ${finding.basis || `${item.previous.basis} → ${item.current.basis}`} |`;
  }) : ["| - | - | - |"];
}

function report(snapshot, diff) {
  return [
    `# Live warning snapshot — ${repository}`,
    "",
    `- Generated: ${snapshot.generatedAt}`,
    `- Previous: ${diff.previousSnapshot || "없음 (첫 snapshot)"}`,
    `- PRs: ${snapshot.summary.prCount}`,
    `- Pairs: ${snapshot.summary.pairCount}`,
    `- Findings: ${snapshot.findings.length}`,
    `- No-alert exploration controls: ${snapshot.explorationControls.length}`,
    `- Model: ${snapshot.run.model || "deterministic only"}`,
    "",
    "## Diff",
    "",
    `- New warnings: ${diff.counts.new}`,
    `- Changed warnings: ${diff.counts.changed}`,
    `- Cleared warnings: ${diff.counts.cleared}`,
    `- Out of scope/closed: ${diff.counts.outOfScope}`,
    `- Unchanged warnings: ${diff.counts.unchanged}`,
    `- New/changed exploration controls: ${(diff.exploration?.counts.new || 0) + (diff.exploration?.counts.changed || 0)}`,
    "",
    "### New",
    "",
    "| Pair | Verdict | Basis |",
    "|---|---|---|",
    ...findingLines(diff.new),
    "",
    "### Changed",
    "",
    "| Pair | Verdict | Basis |",
    "|---|---|---|",
    ...findingLines(diff.changed),
    "",
  ].join("\n");
}

async function main() {
  const startedAt = new Date();
  const prs = await fetchOpenPullRequests(repository, process.env.GITHUB_TOKEN, { limit });
  const pipeline = await prepareAnalysisPipeline(prs, { repository, useMergePreflight: !has("--no-preflight") });
  const aiOptions = { aiProvider: value("--ai-provider") };
  const provider = has("--ai") ? semanticJudgeProvider(aiOptions) : null;
  const aiFindings = has("--ai") ? await analyzeWithAI(pipeline.prepared, aiOptions) : [];
  const analysis = finishAnalysis(pipeline.prepared, aiFindings);
  const prsById = new Map(analysis.prs.map((pr) => [String(pr.id), pr]));
  const explorationControls = selectExplorationControls({
    repository,
    comparisons: pipeline.prepared.comparisons,
    prs: analysis.prs,
    findingKeys: analysis.findings.map((finding) => finding.key),
    stacks: pipeline.preflight.stacks,
    limit: explorationLimit,
  });
  const generatedAt = new Date().toISOString();
  const snapshot = {
    schemaVersion: "live-warning-snapshot-v0.1",
    repository,
    generatedAt,
    run: {
      requestedLimit: limit,
      fetchedPrCount: prs.length,
      provider,
      model: modelName(provider),
      startedAt: startedAt.toISOString(),
      finishedAt: generatedAt,
    },
    summary: analysis.summary,
    preflight: pipeline.preflight,
    prs: analysis.prs.map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, headSha: pr.headSha, base: pr.base, baseSha: pr.baseSha, updatedAt: pr.updatedAt })),
    findings: analysis.findings.map((finding) => normalizeFinding(finding, prsById)),
    explorationControls,
  };
  snapshot.snapshotFingerprint = createHash("sha256").update(JSON.stringify({ findings: snapshot.findings, explorationControls })).digest("hex");
  const repoRoot = join(outputRoot, repository.replace("/", "__"));
  const previous = await latestSnapshot(repoRoot);
  const diff = compareLiveSnapshots(previous, snapshot);
  const runId = generatedAt.replace(/[:.]/g, "-");
  const output = join(repoRoot, runId);
  await mkdir(output, { recursive: true });
  const markdown = report(snapshot, diff);
  await Promise.all([
    writeFile(join(output, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`),
    writeFile(join(output, "inputs.jsonl"), `${JSON.stringify({ schemaVersion: "live-input-v0.1", repository, prs: analysis.prs })}\n`),
    writeFile(join(output, "diff.json"), `${JSON.stringify(diff, null, 2)}\n`),
    writeFile(join(output, "report.md"), markdown),
  ]);
  console.log(markdown);
  console.log(`Saved: ${output}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
