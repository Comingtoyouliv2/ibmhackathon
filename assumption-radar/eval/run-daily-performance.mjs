#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { prepareIntegratedAnalysis } from "../src/integrated.mjs";
import { evaluateRecords } from "./evaluate.mjs";
import { compareFrozenPredictions } from "./performance-utils.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SUITE = join(ROOT, "benchmarks", "semantic-clean-v0.1", "frozen-v0.1");
const DEFAULT_OUTPUT = join(ROOT, ".cache", "performance-runs", "semantic-clean-v0.1");
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const pct = (number) => number === null || number === undefined ? "n/a" : `${(number * 100).toFixed(1)}%`;

async function readJsonl(path) {
  return (await readFile(path, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
}

async function latestRun(outputRoot) {
  try {
    const names = (await readdir(outputRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of names) {
      try {
        const predictions = await readJsonl(join(outputRoot, name, "predictions.jsonl"));
        return { name, predictions };
      } catch { /* Ignore incomplete runs. */ }
    }
  } catch { /* First run. */ }
  return null;
}

function report({ run, metrics, comparison }) {
  const rows = comparison.rows.length
    ? comparison.rows.map((row) => `| \`${row.id}\` | ${row.gold} | ${row.previous ?? "-"} | ${row.current ?? "-"} | ${row.change} |`)
    : ["| - | - | - | - | prediction changes 없음 |"];
  return [
    "# Daily frozen performance",
    "",
    `- Run: \`${run.runId}\``,
    `- Previous: ${run.previousRunId ? `\`${run.previousRunId}\`` : "없음 (첫 baseline)"}`,
    `- Benchmark: \`${run.benchmark}\` (${metrics.dataset.evaluated} cases)`,
    `- App commit: \`${run.appCommit}\``,
    "",
    "## Metrics",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Triage precision | ${pct(metrics.triage.precision)} |`,
    `| Triage recall | ${pct(metrics.triage.recall)} |`,
    `| Blocker precision | ${pct(metrics.blocker.precision)} |`,
    `| Blocker recall | ${pct(metrics.blocker.recall)} |`,
    `| False blocker rate | ${pct(metrics.blocker.falsePositiveRate)} |`,
    `| Work reduction | ${pct(metrics.routing.workReduction)} |`,
    `| Selective accuracy | ${pct(metrics.routing.selectiveAccuracy)} |`,
    `| Latency p95 | ${metrics.operations.latencyP95Ms?.toFixed(2) ?? "n/a"} ms |`,
    "",
    "## Previous run diff",
    "",
    `- Improved: ${comparison.counts.improved}`,
    `- Regressed: ${comparison.counts.regressed}`,
    `- Other verdict changes: ${comparison.counts.changed}`,
    `- New baseline cases: ${comparison.counts.newBaseline}`,
    `- Unchanged: ${comparison.counts.unchanged}`,
    "",
    "| Case | Gold | Previous | Current | Change |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

async function gitCommit() {
  try {
    const head = await readFile(join(ROOT, "..", ".git", "HEAD"), "utf8");
    if (!head.startsWith("ref:")) return head.trim();
    const ref = head.slice(5).trim();
    return (await readFile(join(ROOT, "..", ".git", ref), "utf8")).trim();
  } catch {
    return process.env.APP_COMMIT || "isolated-candidate";
  }
}

async function main() {
  const suite = resolve(value("--suite", DEFAULT_SUITE));
  const outputRoot = resolve(value("--output-root", DEFAULT_OUTPUT));
  const [inputs, gold, previous] = await Promise.all([
    readJsonl(join(suite, "inputs.jsonl")),
    readJsonl(join(suite, "gold.jsonl")),
    latestRun(outputRoot),
  ]);
  const startedAt = new Date();
  const predictions = inputs.map((record) => {
    const start = performance.now();
    const comparison = prepareIntegratedAnalysis(record.prs).comparisons[0];
    return {
      id: record.id,
      prediction: comparison.verdict,
      latencyMs: performance.now() - start,
      tokens: 0,
      costUsd: 0,
    };
  });
  const goldById = new Map(gold.map((record) => [record.id, record]));
  const metrics = evaluateRecords(predictions.map((prediction) => ({
    ...goldById.get(prediction.id),
    ...prediction,
    witnessTypes: [],
  })));
  const comparison = compareFrozenPredictions(gold, previous?.predictions, predictions);
  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const output = join(outputRoot, runId);
  const run = {
    schemaVersion: "daily-performance-run-v0.1",
    runId,
    benchmark: "semantic-clean-v0.1/frozen-v0.1",
    previousRunId: previous?.name ?? null,
    appCommit: await gitCommit(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    cases: inputs.length,
    completeBenchmark: true,
  };
  await mkdir(output, { recursive: true });
  const markdown = report({ run, metrics, comparison });
  await Promise.all([
    writeFile(join(output, "run.json"), `${JSON.stringify(run, null, 2)}\n`),
    writeFile(join(output, "predictions.jsonl"), jsonl(predictions)),
    writeFile(join(output, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`),
    writeFile(join(output, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`),
    writeFile(join(output, "report.md"), markdown),
  ]);
  console.log(markdown);
  console.log(`Saved: ${output}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
