#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rubric = JSON.parse(readFileSync(resolve(scriptDir, "../references/rubric.json"), "utf8"));

function repositoryRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : process.cwd();
}

const root = repositoryRoot();

function artifactPath(path) {
  return isAbsolute(path) ? path : resolve(root, path);
}

if (process.argv.length !== 4) {
  process.stderr.write("Usage: compare-scorecards.mjs BEFORE.json AFTER.json\n");
  process.exit(1);
}

const before = JSON.parse(readFileSync(artifactPath(process.argv[2]), "utf8"));
const after = JSON.parse(readFileSync(artifactPath(process.argv[3]), "utf8"));

if (before.rubricHash !== after.rubricHash) {
  process.stderr.write("Scorecards use different rubric hashes and are not trend-comparable.\n");
  process.exit(2);
}
if (before.snapshot?.id === after.snapshot?.id) {
  process.stderr.write("Scorecards reference the same snapshot; no improvement can be attributed.\n");
  process.exit(2);
}

const signed = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
const rows = Object.entries(rubric.criteria).map(([key, definition]) => {
  const from = before.criteria[key].score;
  const to = after.criteria[key].score;
  return `| ${definition.name} | ${from.toFixed(1)} | ${to.toFixed(1)} | ${signed(to - from)} |`;
});
const minimumCriterion = Math.min(...Object.keys(rubric.criteria).map((key) => after.criteria[key].score));
const target = rubric.defaultTarget;
const gatePass = after.total >= target.total
  && minimumCriterion >= target.minimumCriterion
  && (!target.requiresNoFatalRisk || after.fatalRisks.length === 0);

process.stdout.write(
  `# Mock-jury score delta\n\n`
  + `- Before: \`${before.snapshot.id}\`\n`
  + `- After: \`${after.snapshot.id}\`\n`
  + `- Total: ${before.total.toFixed(1)} → ${after.total.toFixed(1)} (${signed(after.total - before.total)})\n`
  + `- Numeric target gate: **${gatePass ? "PASS" : "NOT YET"}**\n\n`
  + `| Criterion | Before | After | Delta |\n|---|---:|---:|---:|\n`
  + `${rows.join("\n")}\n`
);
