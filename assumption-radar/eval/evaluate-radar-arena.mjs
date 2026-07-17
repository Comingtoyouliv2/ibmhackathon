#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [goldArg, predictionsArg, outputArg] = process.argv.slice(2);
if (!goldArg || !predictionsArg) {
  console.error("Usage: node eval/evaluate-radar-arena.mjs <gold.jsonl> <predictions.jsonl> [output-dir]");
  process.exit(1);
}
const K_VALUES = [5, 10, 20];

async function readJsonl(path) {
  const text = await readFile(resolve(path), "utf8");
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
}

const pairKey = (episodeId, a, b) => `${episodeId}:${[a, b].sort().join(":")}`;
const ratio = (a, b) => b ? a / b : null;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pct = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

function averagePrecision(rows, positiveTotal, goldByKey) {
  let found = 0;
  let sum = 0;
  rows.forEach((row, index) => {
    if (goldByKey.get(pairKey(row.episodeId, row.prA, row.prB))?.gold !== "conflict") return;
    found += 1;
    sum += found / (index + 1);
  });
  return ratio(sum, positiveTotal);
}

function markdown(metrics) {
  return [
    "# End-to-End Radar Arena result",
    "",
    `- Episodes: ${metrics.dataset.episodes}`,
    `- PRs: ${metrics.dataset.prs} total (${metrics.dataset.prsPerEpisode.join(" / ")} per episode)`,
    `- Candidate pairs: ${metrics.dataset.candidatePairs}`,
    `- Gold conflict pairs: ${metrics.dataset.conflicts}`,
    `- Historical hard negatives: ${metrics.dataset.historicalHardNegatives}`,
    `- Mean Average Precision@20: ${pct(metrics.macro.meanAveragePrecisionAt20)}`,
    "",
    "| Budget | Macro recall | Macro precision | Pair reduction |",
    "|---:|---:|---:|---:|",
    ...K_VALUES.map((k) => `| ${k} | ${pct(metrics.macro[`recallAt${k}`])} | ${pct(metrics.macro[`precisionAt${k}`])} | ${pct(metrics.macro[`pairReductionAt${k}`])} |`),
    "",
    "## Episodes",
    "",
    ...metrics.episodes.flatMap((episode) => [
      `### ${episode.episodeId}`,
      "",
      `- AP@20: ${pct(episode.averagePrecisionAt20)}`,
      `- Recall@5/10/20: ${pct(episode.recallAt5)} / ${pct(episode.recallAt10)} / ${pct(episode.recallAt20)}`,
      `- Precision@5/10/20: ${pct(episode.precisionAt5)} / ${pct(episode.precisionAt10)} / ${pct(episode.precisionAt20)}`,
      `- Historical hard negatives in top 20: ${episode.historicalHardNegativesAt20}`,
      `- Isolated-module controls in top 20: ${episode.isolatedModuleControlsAt20}`,
      "",
    ]),
    `## Missed conflict pairs at top 20 (${metrics.missedAt20.length})`,
    "",
    ...(metrics.missedAt20.length ? metrics.missedAt20.map((item) => `- \`${item.id}\` · ${item.sourceRepo} · ${item.archetype}`) : ["- None"]),
    "",
    "> This controlled arena measures pair discovery plus judgment over anonymized historical changes in isolated monorepo modules. It is not evidence of natural open-PR prevalence or cross-language generalization.",
    "",
  ].join("\n");
}

async function main() {
  const [gold, predictions] = await Promise.all([readJsonl(goldArg), readJsonl(predictionsArg)]);
  const goldByKey = new Map(gold.map((record) => [pairKey(record.episodeId, record.prA, record.prB), record]));
  const episodeIds = [...new Set(gold.map((record) => record.episodeId))].sort();
  const episodeResults = [];
  const missedAt20 = [];

  for (const episodeId of episodeIds) {
    const episodeGold = gold.filter((record) => record.episodeId === episodeId);
    const rows = predictions.filter((record) => record.episodeId === episodeId).sort((a, b) => a.rank - b.rank);
    if (rows.length < 20) throw new Error(`${episodeId}: expected at least 20 predictions, got ${rows.length}`);
    const positives = episodeGold.filter((record) => record.gold === "conflict");
    const result = { episodeId, candidatePairs: episodeGold.length, positives: positives.length };
    for (const k of K_VALUES) {
      const top = rows.slice(0, k);
      const tp = top.filter((row) => goldByKey.get(pairKey(episodeId, row.prA, row.prB))?.gold === "conflict").length;
      result[`recallAt${k}`] = ratio(tp, positives.length);
      result[`precisionAt${k}`] = ratio(tp, k);
      result[`pairReductionAt${k}`] = 1 - ratio(k, episodeGold.length);
    }
    const top20Gold = rows.slice(0, 20).map((row) => goldByKey.get(pairKey(episodeId, row.prA, row.prB))).filter(Boolean);
    result.averagePrecisionAt20 = averagePrecision(rows.slice(0, 20), positives.length, goldByKey);
    result.historicalHardNegativesAt20 = top20Gold.filter((record) => record.controlType === "historical-hard-negative").length;
    result.isolatedModuleControlsAt20 = top20Gold.filter((record) => record.controlType === "isolated-module-control").length;
    const retrieved = new Set(rows.slice(0, 20).map((row) => pairKey(episodeId, row.prA, row.prB)));
    missedAt20.push(...positives.filter((record) => !retrieved.has(pairKey(episodeId, record.prA, record.prB))));
    episodeResults.push(result);
  }

  const macro = { meanAveragePrecisionAt20: mean(episodeResults.map((item) => item.averagePrecisionAt20)) };
  for (const k of K_VALUES) {
    for (const metric of ["recall", "precision", "pairReduction"]) {
      macro[`${metric}At${k}`] = mean(episodeResults.map((item) => item[`${metric}At${k}`]));
    }
  }
  const metrics = {
    generatedAt: new Date().toISOString(),
    dataset: {
      episodes: episodeIds.length,
      prs: episodeIds.length * 40,
      prsPerEpisode: episodeIds.map((episodeId) => Math.max(...gold.filter((record) => record.episodeId === episodeId).flatMap((record) => [Number(record.prA.slice(3)), Number(record.prB.slice(3))]))),
      candidatePairs: gold.length,
      conflicts: gold.filter((record) => record.gold === "conflict").length,
      historicalHardNegatives: gold.filter((record) => record.controlType === "historical-hard-negative").length,
      isolatedModuleControls: gold.filter((record) => record.controlType === "isolated-module-control").length,
    },
    macro,
    episodes: episodeResults,
    missedAt20,
  };
  const outputDir = resolve(outputArg || predictionsArg.replace(/\/[^/]+$/, ""));
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`),
    writeFile(join(outputDir, "missed-at-20.jsonl"), `${missedAt20.map((item) => JSON.stringify(item)).join("\n")}${missedAt20.length ? "\n" : ""}`),
    writeFile(join(outputDir, "report.md"), markdown(metrics)),
  ]);
  console.log(markdown(metrics));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
