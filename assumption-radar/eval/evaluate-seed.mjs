#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl } from "./evaluate.mjs";

const RELATIONSHIPS = new Set(["conflict", "coordination-required", "compatible", "review", "insufficient"]);
const DISPOSITIONS = new Set(["analyzed", "filtered"]);

const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
const percent = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

function normalizePrediction(value) {
  if (value === "coordination") return "coordination-required";
  if (value === "independent") return "compatible";
  return value;
}

export function validateSeedRecords(goldRecords, predictionRecords) {
  const errors = [];
  const goldIds = new Set();
  const predictionIds = new Set();

  goldRecords.forEach((record, index) => {
    if (!record.id) errors.push(`gold line ${index + 1}: id is required`);
    else if (goldIds.has(record.id)) errors.push(`gold line ${index + 1}: duplicate id '${record.id}'`);
    else goldIds.add(record.id);
    if (!Array.isArray(record.pullRequests) || record.pullRequests.length !== 2) errors.push(`gold line ${index + 1}: exactly two pullRequests are required`);
    if (!RELATIONSHIPS.has(record.goldRelationship)) errors.push(`gold line ${index + 1}: invalid goldRelationship '${record.goldRelationship}'`);
    if (!new Set(["included", "excluded"]).has(record.relationshipBenchmarkEligibility)) errors.push(`gold line ${index + 1}: invalid relationshipBenchmarkEligibility`);
    if (!new Set(["included", "excluded"]).has(record.semanticBenchmarkEligibility)) errors.push(`gold line ${index + 1}: invalid semanticBenchmarkEligibility`);
  });

  predictionRecords.forEach((record, index) => {
    if (!record.id) errors.push(`prediction line ${index + 1}: id is required`);
    else if (predictionIds.has(record.id)) errors.push(`prediction line ${index + 1}: duplicate id '${record.id}'`);
    else predictionIds.add(record.id);
    if (!DISPOSITIONS.has(record.disposition)) errors.push(`prediction line ${index + 1}: invalid disposition '${record.disposition}'`);
    const relationship = normalizePrediction(record.predictedRelationship);
    if (record.disposition === "analyzed" && !RELATIONSHIPS.has(relationship)) errors.push(`prediction line ${index + 1}: invalid predictedRelationship '${record.predictedRelationship}'`);
  });

  for (const id of goldIds) if (!predictionIds.has(id)) errors.push(`missing prediction for '${id}'`);
  for (const id of predictionIds) if (!goldIds.has(id)) errors.push(`prediction has unknown id '${id}'`);
  if (errors.length) throw new Error(errors.slice(0, 20).join("\n"));
}

function relationshipBreakdown(records) {
  const labels = [...new Set(records.map((record) => record.goldRelationship))].sort();
  return Object.fromEntries(labels.map((label) => {
    const matching = records.filter((record) => record.goldRelationship === label);
    return [label, {
      total: matching.length,
      exact: matching.filter((record) => record.normalizedPrediction === label).length,
      accuracy: ratio(matching.filter((record) => record.normalizedPrediction === label).length, matching.length),
      predictions: Object.fromEntries([...new Set(matching.map((record) => record.normalizedPrediction))].sort().map((prediction) => [prediction, matching.filter((record) => record.normalizedPrediction === prediction).length])),
    }];
  }));
}

export function evaluateSeed(goldRecords, predictionRecords) {
  validateSeedRecords(goldRecords, predictionRecords);
  const predictions = new Map(predictionRecords.map((record) => [record.id, record]));
  const joined = goldRecords.map((gold) => {
    const prediction = predictions.get(gold.id);
    return { ...gold, ...prediction, normalizedPrediction: normalizePrediction(prediction.predictedRelationship) };
  });

  const expectedFiltered = joined.filter((record) => record.relationshipBenchmarkEligibility === "excluded");
  const expectedAnalyzed = joined.filter((record) => record.relationshipBenchmarkEligibility === "included");
  const predictedFiltered = joined.filter((record) => record.disposition === "filtered");
  const correctlyFiltered = expectedFiltered.filter((record) => record.disposition === "filtered");
  const incorrectlyFiltered = expectedAnalyzed.filter((record) => record.disposition === "filtered");

  const relationshipRecords = expectedAnalyzed.filter((record) => record.disposition === "analyzed");
  const relationshipExact = relationshipRecords.filter((record) => record.goldRelationship === record.normalizedPrediction);
  const coordinationRecords = relationshipRecords.filter((record) => record.goldRelationship === "coordination-required");
  const subtypeAnnotated = coordinationRecords.filter((record) => record.goldCoordinationSubtype);
  const actionAnnotated = coordinationRecords.filter((record) => record.goldRequiredAction);

  const silentSemantic = joined.filter((record) => record.semanticBenchmarkEligibility === "included" && record.disposition === "analyzed");
  const silentConflicts = silentSemantic.filter((record) => record.goldRelationship === "conflict");
  const silentCompatible = silentSemantic.filter((record) => record.goldRelationship === "compatible");
  const triagePredictions = new Set(["conflict", "coordination-required", "review"]);

  const errors = joined.filter((record) => {
    if (record.relationshipBenchmarkEligibility === "excluded") return record.disposition !== "filtered";
    return record.disposition !== "analyzed" || record.goldRelationship !== record.normalizedPrediction;
  }).map((record) => ({
    id: record.id,
    expected: record.relationshipBenchmarkEligibility === "excluded" ? "filtered" : record.goldRelationship,
    actual: record.disposition === "filtered" ? "filtered" : record.normalizedPrediction,
  }));
  const explanationGaps = coordinationRecords.flatMap((record) => [
    ...(record.goldCoordinationSubtype && record.goldCoordinationSubtype !== record.predictedCoordinationSubtype ? [{
      id: record.id, dimension: "coordination-subtype", expected: record.goldCoordinationSubtype, actual: record.predictedCoordinationSubtype || "missing",
    }] : []),
    ...(record.goldRequiredAction && record.goldRequiredAction !== record.predictedRequiredAction ? [{
      id: record.id, dimension: "required-action", expected: record.goldRequiredAction, actual: record.predictedRequiredAction || "missing",
    }] : []),
  ]);

  return {
    schemaVersion: "seed-evaluation-v0.1",
    generatedAt: new Date().toISOString(),
    dataset: {
      total: joined.length,
      relationshipEvaluated: expectedAnalyzed.length,
      relationshipExcluded: expectedFiltered.length,
      silentSemanticEvaluated: silentSemantic.length,
      repositories: new Set(joined.map((record) => record.repository)).size,
    },
    filtering: {
      expectedFiltered: expectedFiltered.length,
      predictedFiltered: predictedFiltered.length,
      correctlyFiltered: correctlyFiltered.length,
      incorrectlyFiltered: incorrectlyFiltered.length,
      recall: ratio(correctlyFiltered.length, expectedFiltered.length),
      precision: ratio(correctlyFiltered.length, predictedFiltered.length),
    },
    relationship: {
      exact: relationshipExact.length,
      total: relationshipRecords.length,
      accuracy: ratio(relationshipExact.length, relationshipRecords.length),
      byGold: relationshipBreakdown(relationshipRecords),
    },
    coordination: {
      total: coordinationRecords.length,
      detected: coordinationRecords.filter((record) => record.normalizedPrediction === "coordination-required").length,
      recall: ratio(coordinationRecords.filter((record) => record.normalizedPrediction === "coordination-required").length, coordinationRecords.length),
      subtypeAnnotated: subtypeAnnotated.length,
      subtypeExact: subtypeAnnotated.filter((record) => record.goldCoordinationSubtype === record.predictedCoordinationSubtype).length,
      subtypeAccuracy: ratio(subtypeAnnotated.filter((record) => record.goldCoordinationSubtype === record.predictedCoordinationSubtype).length, subtypeAnnotated.length),
      actionAnnotated: actionAnnotated.length,
      actionExact: actionAnnotated.filter((record) => record.goldRequiredAction === record.predictedRequiredAction).length,
      actionAccuracy: ratio(actionAnnotated.filter((record) => record.goldRequiredAction === record.predictedRequiredAction).length, actionAnnotated.length),
    },
    silentSemantic: {
      total: silentSemantic.length,
      conflicts: silentConflicts.length,
      compatible: silentCompatible.length,
      triageRecall: ratio(silentConflicts.filter((record) => triagePredictions.has(record.normalizedPrediction)).length, silentConflicts.length),
      harmlessReviewRate: ratio(silentCompatible.filter((record) => record.normalizedPrediction === "review").length, silentCompatible.length),
      compatibleExactRate: ratio(silentCompatible.filter((record) => record.normalizedPrediction === "compatible").length, silentCompatible.length),
    },
    errors,
    explanationGaps,
  };
}

export function renderSeedReport(result, goldPath, predictionsPath) {
  const lines = [
    "# Scikit-learn seed baseline",
    "",
    `- Gold: \`${goldPath}\``,
    `- Predictions: \`${predictionsPath}\``,
    `- Generated: ${result.generatedAt}`,
    "",
    "## Dataset",
    "",
    `- ${result.dataset.total} raw cases`,
    `- ${result.dataset.relationshipEvaluated} independent relationship cases`,
    `- ${result.dataset.relationshipExcluded} filtered stack/alias controls`,
    `- ${result.dataset.silentSemanticEvaluated} silent semantic cases`,
    "",
    "## Baseline",
    "",
    `- Stack/alias filter recall: ${percent(result.filtering.recall)} (${result.filtering.correctlyFiltered}/${result.filtering.expectedFiltered})`,
    `- Exact relationship accuracy: ${percent(result.relationship.accuracy)} (${result.relationship.exact}/${result.relationship.total})`,
    `- Coordination recall: ${percent(result.coordination.recall)} (${result.coordination.detected}/${result.coordination.total})`,
    `- Coordination subtype accuracy: ${percent(result.coordination.subtypeAccuracy)} (${result.coordination.subtypeExact}/${result.coordination.subtypeAnnotated})`,
    `- Required-action accuracy: ${percent(result.coordination.actionAccuracy)} (${result.coordination.actionExact}/${result.coordination.actionAnnotated})`,
    `- Silent compatible exact rate: ${percent(result.silentSemantic.compatibleExactRate)}`,
    `- Silent harmless review rate: ${percent(result.silentSemantic.harmlessReviewRate)}`,
    "",
    "## Errors",
    "",
    ...(result.errors.length ? result.errors.map((error) => `- \`${error.id}\`: expected \`${error.expected}\`, got \`${error.actual}\``) : ["- None"]),
    "",
    "## Explanation and action gaps",
    "",
    ...(result.explanationGaps.length ? result.explanationGaps.map((gap) => `- \`${gap.id}\` · ${gap.dimension}: expected \`${gap.expected}\`, got \`${gap.actual}\``) : ["- None"]),
    "",
    "> This seed is a regression anchor, not a generalization claim. The sample is too small and comes from one repository.",
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const goldPath = args[0];
  const predictionsPath = args[1];
  if (!goldPath || !predictionsPath || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node eval/evaluate-seed.mjs <gold.jsonl> <predictions.jsonl> [--json] [--output-dir <dir>]");
    return;
  }
  const result = evaluateSeed(await readJsonl(goldPath), await readJsonl(predictionsPath));
  const report = renderSeedReport(result, basename(goldPath), basename(predictionsPath));
  const outputIndex = args.indexOf("--output-dir");
  if (outputIndex >= 0) {
    const outputDir = args[outputIndex + 1];
    if (!outputDir) throw new Error("--output-dir requires a path");
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(join(outputDir, "report.md"), report);
  }
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(report);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
