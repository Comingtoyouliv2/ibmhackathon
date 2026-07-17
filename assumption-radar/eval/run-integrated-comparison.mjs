#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const output = resolve(process.argv[2] || "benchmarks/comparisons/integrated-v0.1-latest");
const team1Source = resolve(process.argv[3] || "benchmarks/comparisons/frozen-comparison-v0.2-smoke-2026-07-17/team1");
const pairSuite = resolve("handoff/semantic-conflict-pair-judgment-v0.1");
const radarSuite = resolve("handoff/semantic-conflict-end-to-end-v0.1");
const pairGold = resolve("benchmarks/semantic-clean-v0.1/frozen-v0.1/gold.jsonl");
const radarGold = resolve("benchmarks/radar-arena-v0.1/private/gold.jsonl");

function run(args) {
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: "inherit", maxBuffer: 128 * 1024 * 1024 });
}

for (const system of ["current", "team2", "integrated"]) {
  run(["eval/run-local-system.mjs", system, "pair", "--suite", pairSuite, "--output", join(output, system, "pair")]);
  run(["eval/run-local-system.mjs", system, "radar", "--suite", radarSuite, "--output", join(output, system, "radar")]);
}

for (const track of ["pair", "radar"]) {
  const destination = join(output, "team1", track);
  await mkdir(destination, { recursive: true });
  await Promise.all(["predictions.jsonl", "run.json"].map((name) => copyFile(join(team1Source, track, name), join(destination, name))));
}

for (const system of ["current", "team1", "team2", "integrated"]) {
  run(["eval/evaluate-pair-qualification.mjs", pairGold, join(output, system, "pair", "predictions.jsonl"), join(output, system, "pair-score")]);
  run(["eval/evaluate-radar-arena.mjs", radarGold, join(output, system, "radar", "predictions.jsonl"), join(output, system, "radar-score")]);
}

run([
  "eval/summarize-system-comparison.mjs", output,
  `current=${join(output, "current")}`,
  `team1=${join(output, "team1")}`,
  `team2-design-prototype=${join(output, "team2")}`,
  `integrated=${join(output, "integrated")}`,
]);
console.log(`Integrated comparison complete: ${output}`);
