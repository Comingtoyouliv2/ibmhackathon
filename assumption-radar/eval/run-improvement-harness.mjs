#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeRoutes, routeFrozenFailures, routeLiveDiff } from "./improvement-routing.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const DEFAULT_AI_PERFORMANCE_ROOT = join(ROOT, ".cache", "performance-runs", "semantic-clean-v0.1-ai");
const DEFAULT_DETERMINISTIC_PERFORMANCE_ROOT = join(ROOT, ".cache", "performance-runs", "semantic-clean-v0.1");
const DEFAULT_LIVE_ROOT = join(ROOT, ".cache", "live-snapshots");
const DEFAULT_OUTPUT_ROOT = join(ROOT, ".cache", "improvement-harness");
const GOLD = join(ROOT, "benchmarks", "semantic-clean-v0.1", "frozen-v0.1", "gold.jsonl");
const LEDGER = join(ROOT, "benchmarks", "semantic-clean-v0.1", "frozen-v0.1", "error-ledger-v0.9.0.jsonl");
const jsonl = (rows) => rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";

async function readJsonl(path) {
  return (await readFile(path, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
}

async function latestDirectory(root) {
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  if (!names.length) throw new Error(`no run directories in ${root}`);
  return join(root, names[0]);
}

async function latestCompletePerformanceRun(root) {
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  for (const name of names) {
    try {
      const run = JSON.parse(await readFile(join(root, name, "run.json"), "utf8"));
      if (run.completeBenchmark === true || (run.completeBenchmark === undefined && run.cases === 40)) return join(root, name);
    } catch { /* Ignore incomplete runs. */ }
  }
  throw new Error(`no complete 40-case performance run in ${root}`);
}

async function latestLiveRuns(root) {
  try {
    const repos = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    return Promise.all(repos.map((entry) => latestDirectory(join(root, entry.name))));
  } catch { return []; }
}

function section(title, items, render) {
  return [
    `## ${title} (${items.length})`,
    "",
    ...(items.length ? items.map(render) : ["- 없음"]),
    "",
  ];
}

function report(run, routed) {
  return [
    "# Improvement harness",
    "",
    `- Generated: ${run.generatedAt}`,
    `- Frozen runs: ${run.performanceRuns.map((path) => `\`${path}\``).join(", ")}`,
    `- Live runs: ${run.liveRuns.length || 0}`,
    "- Routing policy: 이 단계는 작업 패킷만 생성; `improve:execute`가 격리 수정·재검증·조건부 적용을 담당",
    "",
    ...section("Code actions", routed.codeActions, (item) => `- \`${item.id}\` · ${item.caseId || item.logicalKey} · ${item.rootCause || item.reason}`),
    ...section("Prompt actions", routed.promptActions, (item) => `- \`${item.id}\` · ${item.caseId} · ${item.rootCause}`),
    ...section("Verification actions", routed.verificationActions, (item) => `- \`${item.id}\` · ${item.logicalKey} · ${item.verdict || item.kind}`),
    ...section("Human questions", routed.humanQuestions, (item) => `- \`${item.id}\` · ${item.question}`),
  ].join("\n");
}

async function main() {
  const explicitPerformanceRun = value("--performance-run");
  const explicitPerformanceRoot = value("--performance-root");
  let performanceRuns;
  if (explicitPerformanceRun) {
    performanceRuns = [resolve(explicitPerformanceRun)];
  } else if (explicitPerformanceRoot) {
    performanceRuns = [await latestCompletePerformanceRun(resolve(explicitPerformanceRoot))];
  } else {
    performanceRuns = [await latestCompletePerformanceRun(DEFAULT_DETERMINISTIC_PERFORMANCE_ROOT)];
    try { performanceRuns.push(await latestCompletePerformanceRun(DEFAULT_AI_PERFORMANCE_ROOT)); }
    catch { /* AI track has not completed a full 40-case run yet. */ }
  }
  const explicitLive = value("--live-run");
  const liveRuns = explicitLive ? [resolve(explicitLive)] : await latestLiveRuns(resolve(value("--live-root", DEFAULT_LIVE_ROOT)));
  const [gold, ledger] = await Promise.all([readJsonl(GOLD), readJsonl(LEDGER)]);
  const routes = [];
  for (const performanceRun of performanceRuns) {
    routes.push(routeFrozenFailures({ goldRecords: gold, predictions: await readJsonl(join(performanceRun, "predictions.jsonl")), errorLedger: ledger }));
  }
  for (const liveRun of liveRuns) {
    const [snapshot, diff] = await Promise.all([
      readFile(join(liveRun, "snapshot.json"), "utf8").then(JSON.parse),
      readFile(join(liveRun, "diff.json"), "utf8").then(JSON.parse),
    ]);
    routes.push(routeLiveDiff({ repository: snapshot.repository, snapshot, diff }));
  }
  const routed = mergeRoutes(routes);
  const generatedAt = new Date().toISOString();
  const run = {
    schemaVersion: "improvement-harness-run-v0.1",
    generatedAt,
    performanceRuns,
    liveRuns,
    counts: Object.fromEntries(Object.entries(routed).map(([key, items]) => [key, items.length])),
  };
  const output = join(resolve(value("--output-root", DEFAULT_OUTPUT_ROOT)), generatedAt.replace(/[:.]/g, "-"));
  await mkdir(output, { recursive: true });
  const markdown = report(run, routed);
  await Promise.all([
    writeFile(join(output, "run.json"), `${JSON.stringify(run, null, 2)}\n`),
    writeFile(join(output, "code-actions.jsonl"), jsonl(routed.codeActions)),
    writeFile(join(output, "prompt-actions.jsonl"), jsonl(routed.promptActions)),
    writeFile(join(output, "verification-actions.jsonl"), jsonl(routed.verificationActions)),
    writeFile(join(output, "human-questions.jsonl"), jsonl(routed.humanQuestions)),
    writeFile(join(output, "report.md"), markdown),
  ]);
  console.log(markdown);
  console.log(`Saved: ${output}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
