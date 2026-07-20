#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { analyzeWithCodex } from "../src/codex.mjs";
import { prepareIntegratedAnalysis } from "../src/integrated.mjs";
import { evaluateRecords } from "./evaluate.mjs";
import { aggregateRepeatedVerdicts, compareFrozenPredictions, stableHash } from "./performance-utils.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SUITE = join(ROOT, "benchmarks", "semantic-clean-v0.1", "frozen-v0.1");
const DEFAULT_OUTPUT = join(ROOT, ".cache", "performance-runs", "semantic-clean-v0.1-ai");
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const model = value("--model", process.env.CODEX_MODEL || "gpt-5.6-sol");
const codexBin = value("--codex-bin", process.env.CODEX_BIN || "codex");
const reasoningEffort = value("--reasoning-effort", "medium");
const repeats = Math.max(1, Math.min(5, Number(value("--repeats", "3"))));
const concurrency = Math.max(1, Math.min(8, Number(value("--concurrency", "4"))));
const limit = Math.max(0, Number(value("--limit", "0")));
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const pct = (number) => number === null || number === undefined ? "n/a" : `${(number * 100).toFixed(1)}%`;

async function readJsonl(path) {
  return (await readFile(path, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
}

async function latestRun(outputRoot) {
  try {
    const names = (await readdir(outputRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const name of names) {
      try { return { name, predictions: await readJsonl(join(outputRoot, name, "predictions.jsonl")) }; }
      catch { /* Ignore incomplete runs. */ }
    }
  } catch { /* First run. */ }
  return null;
}

function command(program, commandArgs) {
  return new Promise((done) => execFile(program, commandArgs, { cwd: resolve(ROOT, "..") }, (error, stdout = "") => done(error ? null : stdout.trim())));
}

function chooseResolved(deterministic, judgments, aggregation) {
  if (aggregation.stable) {
    return judgments.find((item) => item?.verdict === aggregation.verdict) || deterministic;
  }
  return {
    ...deterministic,
    verdict: "review",
    basis: "unstable-ai-consensus",
    source: "codex",
    title: "반복 AI 판정이 일치하지 않음",
    summary: "동일한 CASE_JSON의 반복 판정이 갈려 자동 conflict 또는 independent로 확정하지 않습니다.",
  };
}

async function runCase(record) {
  const started = performance.now();
  const prepared = prepareIntegratedAnalysis(record.prs);
  const deterministic = prepared.comparisons[0];
  const resolvedRuns = [];
  const errors = [];
  let modelCalls = 0;
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    try {
      const judgments = await analyzeWithCodex(prepared, { model, codexBin, reasoningEffort, concurrency: 1 });
      if (judgments.length) modelCalls += 1;
      resolvedRuns.push(deterministic.verdict === "conflict" && deterministic.basis === "deterministic-witness"
        ? deterministic : judgments[0] || deterministic);
    } catch (error) {
      errors.push({ repeat: repeat + 1, error: error.message });
    }
  }
  const repeatVerdicts = resolvedRuns.map((item) => item.verdict);
  const aggregation = aggregateRepeatedVerdicts(repeatVerdicts, repeats);
  const resolved = chooseResolved(deterministic, resolvedRuns, aggregation);
  return {
    prediction: {
      schemaVersion: "daily-ai-prediction-v0.1",
      id: record.id,
      prediction: aggregation.verdict,
      source: modelCalls ? "codex" : resolved.source || "framework",
      basis: aggregation.stable ? resolved.basis : "unstable-ai-consensus",
      confidence: aggregation.stable ? resolved.confidence ?? 0.8 : 0.5,
      explanation: resolved.summary || resolved.title || "",
      repeatVerdicts,
      repeatStable: aggregation.stable,
      repeatCounts: aggregation.counts,
      repeatComplete: aggregation.complete,
      completedRepeats: aggregation.completedCount,
      expectedRepeats: aggregation.expectedCount,
      modelCalls,
      errors,
      latencyMs: performance.now() - started,
      tokens: null,
      costUsd: null,
    },
    modelCalls,
  };
}

function report({ run, metrics, comparison, predictions }) {
  const aiPredictions = predictions.filter((item) => item.modelCalls > 0);
  const unstable = aiPredictions.filter((item) => !item.repeatStable);
  return [
    "# Daily full AI performance",
    "",
    `- Run: \`${run.runId}\``,
    `- Previous: ${run.previousRunId ? `\`${run.previousRunId}\`` : "없음 (첫 baseline)"}`,
    `- Benchmark: \`${run.benchmark}\` (${metrics.dataset.evaluated} cases)`,
    `- Model: \`${run.model}\``,
    `- Repeats: ${run.repeats}`,
    `- AI candidate cases: ${aiPredictions.length}`,
    `- Model calls: ${run.modelCalls}`,
    `- AI unstable cases: ${unstable.length}`,
    `- AI stability rate: ${pct(aiPredictions.length ? (aiPredictions.length - unstable.length) / aiPredictions.length : 1)}`,
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Triage precision | ${pct(metrics.triage.precision)} |`,
    `| Triage recall | ${pct(metrics.triage.recall)} |`,
    `| Blocker precision | ${pct(metrics.blocker.precision)} |`,
    `| Blocker recall | ${pct(metrics.blocker.recall)} |`,
    `| False blocker rate | ${pct(metrics.blocker.falsePositiveRate)} |`,
    `| Work reduction | ${pct(metrics.routing.workReduction)} |`,
    "",
    "## Previous run diff",
    "",
    `- Improved: ${comparison.counts.improved}`,
    `- Regressed: ${comparison.counts.regressed}`,
    `- Changed: ${comparison.counts.changed}`,
    `- Unchanged: ${comparison.counts.unchanged}`,
    "",
    "## Unstable AI cases",
    "",
    ...(unstable.length ? unstable.map((item) => `- \`${item.id}\`: ${item.repeatVerdicts.join(" / ")}`) : ["- 없음"]),
    "",
  ].join("\n");
}

async function main() {
  const suite = resolve(value("--suite", DEFAULT_SUITE));
  const outputRoot = resolve(value("--output-root", DEFAULT_OUTPUT));
  const [allInputs, gold, previous, promptSources] = await Promise.all([
    readJsonl(join(suite, "inputs.jsonl")),
    readJsonl(join(suite, "gold.jsonl")),
    latestRun(outputRoot),
    Promise.all([readFile(join(ROOT, "src", "semantic-judge.mjs"), "utf8"), readFile(join(ROOT, "src", "codex.mjs"), "utf8")]),
  ]);
  const inputs = limit ? allInputs.slice(0, limit) : allInputs;
  const startedAt = new Date();
  const predictions = new Array(inputs.length);
  let cursor = 0;
  let modelCalls = 0;
  async function worker() {
    while (cursor < inputs.length) {
      const index = cursor++;
      const result = await runCase(inputs[index]);
      predictions[index] = result.prediction;
      modelCalls += result.modelCalls;
      console.log(`AI performance ${index + 1}/${inputs.length}: ${result.prediction.prediction} [${result.prediction.repeatVerdicts.join(",")}]`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));
  const selectedIds = new Set(inputs.map((record) => record.id));
  const selectedGold = gold.filter((record) => selectedIds.has(record.id));
  const goldById = new Map(selectedGold.map((record) => [record.id, record]));
  const metrics = evaluateRecords(predictions.map((prediction) => ({ ...goldById.get(prediction.id), ...prediction, witnessTypes: [] })));
  const comparablePrevious = previous?.predictions.filter((prediction) => selectedIds.has(prediction.id));
  const comparison = compareFrozenPredictions(selectedGold, comparablePrevious, predictions);
  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const output = join(outputRoot, runId);
  const run = {
    schemaVersion: "daily-ai-performance-run-v0.1",
    runId,
    benchmark: "semantic-clean-v0.1/frozen-v0.1",
    previousRunId: previous?.name ?? null,
    appCommit: await command("git", ["rev-parse", "HEAD"]),
    model,
    codexBin,
    codexCliVersion: await command(codexBin, ["--version"]),
    reasoningEffort,
    repeats,
    cases: inputs.length,
    completeBenchmark: inputs.length === allInputs.length,
    modelCalls,
    promptImplementationSha256: stableHash(promptSources),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
  await mkdir(output, { recursive: true });
  const markdown = report({ run, metrics, comparison, predictions });
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
