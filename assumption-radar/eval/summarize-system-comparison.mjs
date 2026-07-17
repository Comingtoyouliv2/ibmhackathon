#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [outputArg, ...sourceArgs] = process.argv.slice(2);
if (!outputArg || sourceArgs.length < 2) {
  console.error("Usage: node eval/summarize-system-comparison.mjs OUTPUT name=SYSTEM_DIR [...]");
  process.exit(1);
}
const output = resolve(outputArg);
const sources = sourceArgs.map((entry) => {
  const split = entry.indexOf("=");
  if (split < 1) throw new Error(`invalid source: ${entry}`);
  return { name: entry.slice(0, split), path: resolve(entry.slice(split + 1)) };
});
const pct = (value) => value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;

const results = [];
for (const source of sources) {
  const [pair, radar] = await Promise.all([
    readFile(join(source.path, "pair-score", "metrics.json"), "utf8").then(JSON.parse),
    readFile(join(source.path, "radar-score", "metrics.json"), "utf8").then(JSON.parse),
  ]);
  results.push({
    system: source.name,
    pair: {
      triagePrecision: pair.triage.precision, triageRecall: pair.triage.recall, triageF1: pair.triage.f1,
      blockerPrecision: pair.blocker.precision, blockerRecall: pair.blocker.recall,
      falseBlockerRate: pair.blocker.falsePositiveRate, workReduction: pair.routing.workReduction,
      latencyP50Ms: pair.operations.latencyP50Ms,
    },
    radar: radar.macro,
  });
}

const lines = [
  "# Four-system semantic-conflict comparison",
  "",
  "> Team 2 is a runnable retrieval prototype derived from the design document. It is not the unimplemented full Step-3 LLM judge.",
  "",
  "## Pair judgment",
  "",
  "| System | Triage P | Triage R | F1 | Blocker P | Blocker R | False blocker | Work reduction | p50 |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...results.map((row) => `| ${row.system} | ${pct(row.pair.triagePrecision)} | ${pct(row.pair.triageRecall)} | ${pct(row.pair.triageF1)} | ${pct(row.pair.blockerPrecision)} | ${pct(row.pair.blockerRecall)} | ${pct(row.pair.falseBlockerRate)} | ${pct(row.pair.workReduction)} | ${row.pair.latencyP50Ms?.toFixed(1) ?? "n/a"} ms |`),
  "",
  "## End-to-end radar",
  "",
  "| System | MAP@20 | R@5 | P@5 | R@10 | P@10 | R@20 | P@20 |",
  "|---|---:|---:|---:|---:|---:|---:|---:|",
  ...results.map((row) => `| ${row.system} | ${pct(row.radar.meanAveragePrecisionAt20)} | ${pct(row.radar.recallAt5)} | ${pct(row.radar.precisionAt5)} | ${pct(row.radar.recallAt10)} | ${pct(row.radar.precisionAt10)} | ${pct(row.radar.recallAt20)} | ${pct(row.radar.precisionAt20)} |`),
  "",
];
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(join(output, "comparison.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`),
  writeFile(join(output, "comparison.md"), `${lines.join("\n")}\n`),
]);
console.log(lines.join("\n"));
