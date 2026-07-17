#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { evaluateRecords } from "./evaluate.mjs";

const [goldArg, predictionsArg, outputArg] = process.argv.slice(2);
if (!goldArg || !predictionsArg) {
  console.error("Usage: node eval/evaluate-pair-qualification.mjs <gold.jsonl> <predictions.jsonl> [output-dir]");
  process.exit(1);
}

async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${path}:${index + 1}: invalid JSON (${error.message})`);
    }
  });
}

const pct = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

function report(metrics, errors, predictionsPath) {
  return [
    "# Pair qualification result",
    "",
    `- Predictions: \`${basename(predictionsPath)}\``,
    `- Cases: ${metrics.dataset.evaluated} (${metrics.dataset.conflicts} conflict / ${metrics.dataset.harmless} harmless)`,
    `- Triage precision: ${pct(metrics.triage.precision)}`,
    `- Triage recall: ${pct(metrics.triage.recall)}`,
    `- Triage F1: ${pct(metrics.triage.f1)}`,
    `- Blocker precision: ${pct(metrics.blocker.precision)}`,
    `- Blocker recall: ${pct(metrics.blocker.recall)}`,
    `- False blocker rate: ${pct(metrics.blocker.falsePositiveRate)}`,
    `- Harmless review rate: ${pct(metrics.routing.harmlessReviewRate)}`,
    `- Work reduction: ${pct(metrics.routing.workReduction)}`,
    `- Decisive coverage: ${pct(metrics.routing.decisiveCoverage)}`,
    `- Selective accuracy: ${pct(metrics.routing.selectiveAccuracy)}`,
    `- Latency p50/p95: ${metrics.operations.latencyP50Ms?.toFixed(2) ?? "n/a"} / ${metrics.operations.latencyP95Ms?.toFixed(2) ?? "n/a"} ms`,
    "",
    "## Errors",
    "",
    ...(errors.length ? errors.map((error) => `- \`${error.id}\`: expected \`${error.gold}\`, got \`${error.prediction}\``) : ["- None"]),
    "",
    "> Evidence and explanation correctness require blinded human adjudication and are not included in these automatic metrics.",
    "",
  ].join("\n");
}

async function main() {
  const goldPath = resolve(goldArg);
  const predictionsPath = resolve(predictionsArg);
  const outputDir = resolve(outputArg || predictionsPath.replace(/\/[^/]+$/, ""));
  const [gold, predictions] = await Promise.all([readJsonl(goldPath), readJsonl(predictionsPath)]);
  const predictionById = new Map(predictions.map((record) => [record.id, record]));
  if (predictionById.size !== predictions.length) throw new Error("predictions contain duplicate ids");

  const missing = gold.filter((record) => !predictionById.has(record.id)).map((record) => record.id);
  const extras = predictions.filter((record) => !gold.some((item) => item.id === record.id)).map((record) => record.id);
  if (missing.length || extras.length) {
    throw new Error(`id mismatch: ${missing.length} missing, ${extras.length} extra`);
  }

  const records = gold.map((goldRecord) => {
    const prediction = predictionById.get(goldRecord.id);
    return {
      ...goldRecord,
      prediction: prediction.prediction,
      latencyMs: prediction.latencyMs,
      tokens: prediction.tokens,
      costUsd: prediction.costUsd,
      witnessTypes: [],
    };
  });
  const metrics = evaluateRecords(records);
  const errors = records.filter((record) =>
    (record.gold === "conflict" && !["conflict", "coordination", "review"].includes(record.prediction)) ||
    (record.gold === "harmless" && ["conflict", "coordination", "review"].includes(record.prediction)));

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`),
    writeFile(resolve(outputDir, "errors.jsonl"), `${errors.map((record) => JSON.stringify({
      id: record.id,
      gold: record.gold,
      prediction: record.prediction,
      repo: record.repo,
      language: record.language,
      archetype: record.archetype,
    })).join("\n")}${errors.length ? "\n" : ""}`),
    writeFile(resolve(outputDir, "report.md"), report(metrics, errors, predictionsPath)),
  ]);
  console.log(report(metrics, errors, predictionsPath));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
