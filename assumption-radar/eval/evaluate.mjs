#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const GOLDS = new Set(["conflict", "harmless"]);
const PREDICTIONS = new Set(["conflict", "coordination", "review", "independent", "insufficient"]);

const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
const mean = (values) => {
  const valid = values.filter((value) => value !== null && Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};

export function wilsonInterval(successes, total, z = 1.96) {
  if (!total) return { low: null, high: null };
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function confusion(records, positivePredictions) {
  const counts = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const record of records) {
    const predicted = positivePredictions.has(record.prediction);
    const actual = record.gold === "conflict";
    if (predicted && actual) counts.tp += 1;
    else if (predicted) counts.fp += 1;
    else if (actual) counts.fn += 1;
    else counts.tn += 1;
  }
  const precision = ratio(counts.tp, counts.tp + counts.fp);
  const recall = ratio(counts.tp, counts.tp + counts.fn);
  return {
    ...counts, precision, recall,
    f1: precision !== null && recall !== null && precision + recall ? (2 * precision * recall) / (precision + recall) : null,
    accuracy: ratio(counts.tp + counts.tn, records.length),
    falsePositiveRate: ratio(counts.fp, counts.fp + counts.tn),
    precision95: wilsonInterval(counts.tp, counts.tp + counts.fp),
    recall95: wilsonInterval(counts.tp, counts.tp + counts.fn),
  };
}

function percentile(values, percentileValue) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function coreMetrics(records) {
  const blocker = confusion(records, new Set(["conflict"]));
  const triage = confusion(records, new Set(["conflict", "coordination", "review"]));
  const goldConflicts = records.filter((record) => record.gold === "conflict").length;
  const goldHarmless = records.length - goldConflicts;
  const reviews = records.filter((record) => record.prediction === "review");
  const decisive = records.filter((record) => record.prediction === "conflict" || record.prediction === "independent");
  const decisiveCorrect = decisive.filter((record) =>
    (record.prediction === "conflict" && record.gold === "conflict") ||
    (record.prediction === "independent" && record.gold === "harmless")).length;
  return {
    total: records.length, goldConflicts, goldHarmless, blocker, triage,
    routing: {
      conflict: records.filter((record) => record.prediction === "conflict").length,
      coordination: records.filter((record) => record.prediction === "coordination").length,
      review: reviews.length,
      independent: records.filter((record) => record.prediction === "independent").length,
      insufficient: records.filter((record) => record.prediction === "insufficient").length,
      triageRecall: triage.recall,
      harmlessReviewRate: ratio(reviews.filter((record) => record.gold === "harmless").length, goldHarmless),
      conflictReviewCapture: ratio(reviews.filter((record) => record.gold === "conflict").length, goldConflicts),
      workReduction: ratio(records.filter((record) => record.prediction === "independent").length, records.length),
      decisiveCoverage: ratio(decisive.length, records.length),
      selectiveAccuracy: ratio(decisiveCorrect, decisive.length),
      insufficientRate: ratio(records.filter((record) => record.prediction === "insufficient").length, records.length),
    },
  };
}

function sliceSummary(records) {
  const core = coreMetrics(records);
  return {
    total: core.total, goldConflicts: core.goldConflicts, goldHarmless: core.goldHarmless,
    blockerPrecision: core.blocker.precision, blockerRecall: core.blocker.recall,
    falseBlockerRate: core.blocker.falsePositiveRate,
    triageRecall: core.routing.triageRecall, harmlessReviewRate: core.routing.harmlessReviewRate,
    decisiveCoverage: core.routing.decisiveCoverage, selectiveAccuracy: core.routing.selectiveAccuracy,
  };
}

function slices(records, dimension) {
  const groups = new Map();
  for (const record of records) {
    const value = record[dimension] || "unknown";
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(record);
  }
  const values = Object.fromEntries([...groups.entries()].map(([key, items]) => [key, sliceSummary(items)]));
  const metrics = ["blockerPrecision", "blockerRecall", "falseBlockerRate", "triageRecall", "harmlessReviewRate", "decisiveCoverage", "selectiveAccuracy"];
  const macro = Object.fromEntries(metrics.map((metric) => [metric, mean(Object.values(values).map((value) => value[metric]))]));
  return { values, macro };
}

function detectorMetrics(records) {
  const types = new Set(records.flatMap((record) => record.witnessTypes || []));
  const totalConflicts = records.filter((record) => record.gold === "conflict").length;
  const totalHarmless = records.filter((record) => record.gold === "harmless").length;
  return Object.fromEntries([...types].sort().map((type) => {
    const activated = records.filter((record) => (record.witnessTypes || []).includes(type));
    const conflicts = activated.filter((record) => record.gold === "conflict");
    const harmless = activated.filter((record) => record.gold === "harmless");
    return [type, {
      activations: activated.length,
      conflictActivations: conflicts.length,
      harmlessActivations: harmless.length,
      conflictCoverage: ratio(conflicts.length, totalConflicts),
      harmlessActivationRate: ratio(harmless.length, totalHarmless),
      uniqueConflictContribution: conflicts.filter((record) => (record.witnessTypes || []).length === 1).length,
      blockerTpContribution: conflicts.filter((record) => record.prediction === "conflict").length,
      blockerFpContribution: harmless.filter((record) => record.prediction === "conflict").length,
      reviewConflict: conflicts.filter((record) => record.prediction === "review").length,
      reviewHarmless: harmless.filter((record) => record.prediction === "review").length,
    }];
  }));
}

export function validateRecords(records) {
  const errors = [];
  records.forEach((record, index) => {
    if (!record.id) errors.push(`line ${index + 1}: id is required`);
    if (!GOLDS.has(record.gold)) errors.push(`line ${index + 1}: invalid gold '${record.gold}'`);
    if (!PREDICTIONS.has(record.prediction)) errors.push(`line ${index + 1}: invalid prediction '${record.prediction}'`);
  });
  if (errors.length) throw new Error(errors.slice(0, 12).join("\n"));
}

export function evaluateRecords(records) {
  validateRecords(records);
  const eligible = records.filter((record) => record.semanticBenchmarkEligibility !== "excluded");
  const core = coreMetrics(eligible);
  const reviewedEvidence = eligible.map((record) => record.evidence).filter(Boolean);
  const evidence = {
    annotated: reviewedEvidence.length,
    validWitnessRate: ratio(reviewedEvidence.filter((item) => item.grade >= 1).length, reviewedEvidence.length),
    exactWitnessRate: ratio(reviewedEvidence.filter((item) => item.grade >= 2).length, reviewedEvidence.length),
    exactLocalizationRate: ratio(reviewedEvidence.filter((item) => item.localization === "symbol" || item.localization === "line").length, reviewedEvidence.length),
    rationaleCompleteness: ratio(reviewedEvidence.filter((item) => item.rationaleComplete === true).length, reviewedEvidence.length),
  };
  const latency = records.map((record) => record.latencyMs).filter(Number.isFinite);
  const tokens = records.map((record) => record.tokens).filter(Number.isFinite);
  const costs = records.map((record) => record.costUsd).filter(Number.isFinite);
  return {
    generatedAt: new Date().toISOString(),
    dataset: {
      total: records.length, evaluated: eligible.length, excluded: records.length - eligible.length,
      conflicts: core.goldConflicts, harmless: core.goldHarmless,
      repos: new Set(eligible.map((record) => record.repo).filter(Boolean)).size,
      languages: new Set(eligible.map((record) => record.language).filter(Boolean)).size,
      archetypes: new Set(eligible.map((record) => record.archetype).filter(Boolean)).size,
    },
    blocker: core.blocker,
    triage: core.triage,
    routing: core.routing,
    evidence,
    operations: {
      samples: latency.length, latencyP50Ms: percentile(latency, 50), latencyP95Ms: percentile(latency, 95),
      tokensMean: mean(tokens), costMeanUsd: mean(costs),
    },
    detectors: detectorMetrics(eligible),
    slices: Object.fromEntries(["repo", "language", "archetype", "distance", "difficulty"].map((dimension) => [dimension, slices(eligible, dimension)])),
  };
}

export async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`line ${index + 1}: invalid JSON (${error.message})`); }
  });
}

const percent = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

function printReport(result, path) {
  console.log(`\nSEMANTIC CONFLICT RUBRIC · ${path}`);
  console.log("─".repeat(72));
  console.log(`${result.dataset.evaluated} evaluated / ${result.dataset.total} total · ${result.dataset.excluded} excluded · ${result.dataset.conflicts} conflicts · ${result.dataset.harmless} harmless · ${result.dataset.repos} repos`);
  console.log("\nTRIAGE");
  console.log(`  conflict recall       ${percent(result.routing.triageRecall)}`);
  console.log(`  harmless review rate  ${percent(result.routing.harmlessReviewRate)}`);
  console.log(`  work reduction        ${percent(result.routing.workReduction)}`);
  console.log("\nBLOCKER");
  console.log(`  precision             ${percent(result.blocker.precision)}  [95% ${percent(result.blocker.precision95.low)} – ${percent(result.blocker.precision95.high)}]`);
  console.log(`  recall                ${percent(result.blocker.recall)}`);
  console.log(`  false blocker rate    ${percent(result.blocker.falsePositiveRate)}`);
  console.log("\nABSTENTION");
  console.log(`  decisive coverage     ${percent(result.routing.decisiveCoverage)}`);
  console.log(`  selective accuracy    ${percent(result.routing.selectiveAccuracy)}`);
  console.log(`  insufficient rate     ${percent(result.routing.insufficientRate)}`);
  console.log("\nEVIDENCE");
  console.log(`  valid / exact         ${percent(result.evidence.validWitnessRate)} / ${percent(result.evidence.exactWitnessRate)} (${result.evidence.annotated} annotated)`);
  console.log("\nDETECTORS");
  for (const [type, metrics] of Object.entries(result.detectors)) console.log(`  ${type.padEnd(28)} ${String(metrics.activations).padStart(3)} acts · conflict ${percent(metrics.conflictCoverage)} · harmless ${percent(metrics.harmlessActivationRate)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const path = args.find((arg) => !arg.startsWith("-"));
  if (!path || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npm run eval -- <predictions.jsonl> [--json]");
    return;
  }
  const result = evaluateRecords(await readJsonl(path));
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else printReport(result, path);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
