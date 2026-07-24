#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

function parseArgs(argv) {
  const options = { scorecard: null, evidence: null, render: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!options.scorecard && !arg.startsWith("--")) options.scorecard = arg;
    else if (arg === "--evidence") options.evidence = argv[++index];
    else if (arg === "--render") options.render = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.scorecard) throw new Error("Provide a scorecard JSON path.");
  return options;
}

function halfPoint(value) {
  return Number.isFinite(value) && Number.isInteger(value * 2);
}

function expectedBand(total) {
  return rubric.bands.find((item) => total >= item.min)?.label;
}

function validateCriterion(key, value, definition, errors) {
  if (!value || typeof value !== "object") {
    errors.push(`${key}: missing criterion object`);
    return;
  }
  if (value.max !== definition.max) errors.push(`${key}: max must be ${definition.max}`);
  if (!halfPoint(value.score) || value.score < 0 || value.score > definition.max) {
    errors.push(`${key}: score must be a 0.5-step number from 0 to ${definition.max}`);
  }
  const expectedDimensions = Object.keys(definition.dimensions);
  const actualDimensions = Object.keys(value.subscores || {});
  for (const dimension of expectedDimensions) {
    const score = value.subscores?.[dimension];
    const max = definition.dimensions[dimension];
    if (!halfPoint(score) || score < 0 || score > max) {
      errors.push(`${key}.${dimension}: must be a 0.5-step number from 0 to ${max}`);
    }
  }
  for (const dimension of actualDimensions) {
    if (!expectedDimensions.includes(dimension)) errors.push(`${key}: unknown subscore ${dimension}`);
  }
  const subtotal = expectedDimensions.reduce((sum, dimension) => sum + (value.subscores?.[dimension] || 0), 0);
  const capMax = value.capApplied?.max ?? definition.max;
  const expectedScore = Math.min(subtotal, capMax);
  if (value.score !== expectedScore) {
    errors.push(`${key}: score ${value.score} must equal min(subscores ${subtotal}, cap ${capMax})`);
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    errors.push(`${key}: evidence must be a nonempty array`);
  } else {
    for (const [index, item] of value.evidence.entries()) {
      if (!["E0", "E1", "E2", "E3", "E4"].includes(item?.tier)) errors.push(`${key}.evidence[${index}]: invalid tier`);
      if (!item?.claim || !item?.source) errors.push(`${key}.evidence[${index}]: claim and source are required`);
    }
  }
  if (!Array.isArray(value.deductions)) errors.push(`${key}: deductions must be an array`);
  if (!value.nextAction?.action || !value.nextAction?.acceptanceEvidence) {
    errors.push(`${key}: nextAction needs action and acceptanceEvidence`);
  }
}

function render(scorecard) {
  const rows = Object.entries(rubric.criteria).map(([key, definition]) => {
    const item = scorecard.criteria[key];
    return `| ${definition.name} | ${item.score}/${item.max} | ${item.capApplied ? `${item.capApplied.max}: ${item.capApplied.reason}` : "—"} |`;
  });
  const evidenceSections = Object.entries(rubric.criteria).map(([key, definition]) => {
    const item = scorecard.criteria[key];
    const evidence = item.evidence.map((entry) => `- ${entry.tier} — ${entry.claim} (\`${entry.source}\`)`).join("\n");
    const deductions = item.deductions.length ? item.deductions.map((entry) => `- ${entry}`).join("\n") : "- None recorded.";
    return `## ${definition.name}\n\nScore: **${item.score}/${item.max}**\n\nEvidence:\n\n${evidence}\n\nDeductions / missing proof:\n\n${deductions}\n\nNext: ${item.nextAction.action}\n\nAcceptance evidence: ${item.nextAction.acceptanceEvidence}`;
  });
  const improvements = scorecard.topImprovements
    .map((item, index) => `${index + 1}. **${item.criterion}** — ${item.action} (hypothesized gain: ${item.expectedGain})\n   - Accept when: ${item.acceptanceEvidence}`)
    .join("\n");
  const risks = scorecard.fatalRisks.length ? scorecard.fatalRisks.map((risk) => `- ${risk}`).join("\n") : "- None identified.";
  return `# IBM AI Builders mock-jury scorecard\n\n- Snapshot: \`${scorecard.snapshot.id}\`\n- Rubric hash: \`${scorecard.rubricHash}\`\n- Total: **${scorecard.total}/100**\n- Band: **${scorecard.band}**\n- Verdict: ${scorecard.verdict}\n\n| Criterion | Score | Applied cap |\n|---|---:|---|\n${rows.join("\n")}\n\n${evidenceSections.join("\n\n")}\n\n## Fatal risks\n\n${risks}\n\n## Highest-leverage improvements\n\n${improvements}\n`;
}

const options = parseArgs(process.argv.slice(2));
const scorecard = JSON.parse(readFileSync(artifactPath(options.scorecard), "utf8"));
const errors = [];

if (scorecard.schemaVersion !== 1) errors.push("schemaVersion must be 1");
if (!scorecard.snapshot?.id || !scorecard.snapshot?.type) errors.push("snapshot id and type are required");
if (!scorecard.rubricHash) errors.push("rubricHash is required");
if (!scorecard.criteria || typeof scorecard.criteria !== "object") errors.push("criteria object is required");

for (const [key, definition] of Object.entries(rubric.criteria)) {
  validateCriterion(key, scorecard.criteria?.[key], definition, errors);
}
for (const key of Object.keys(scorecard.criteria || {})) {
  if (!rubric.criteria[key]) errors.push(`unknown criterion: ${key}`);
}

const total = Object.keys(rubric.criteria).reduce((sum, key) => sum + (scorecard.criteria?.[key]?.score || 0), 0);
if (scorecard.total !== total) errors.push(`total ${scorecard.total} must equal criterion sum ${total}`);
const band = expectedBand(total);
if (scorecard.band !== band) errors.push(`band must be "${band}"`);
if (!Array.isArray(scorecard.fatalRisks)) errors.push("fatalRisks must be an array");
if (!Array.isArray(scorecard.topImprovements) || scorecard.topImprovements.length !== 3) {
  errors.push("topImprovements must contain exactly 3 items");
} else {
  for (const [index, item] of scorecard.topImprovements.entries()) {
    if (!item?.criterion || !item?.action || !item?.expectedGain || !item?.acceptanceEvidence) {
      errors.push(`topImprovements[${index}] is incomplete`);
    }
  }
}

if (options.evidence) {
  const evidence = JSON.parse(readFileSync(artifactPath(options.evidence), "utf8"));
  if (scorecard.rubricHash !== evidence.rubricHash) errors.push("rubricHash does not match evidence bundle");
  if (scorecard.snapshot.id !== evidence.snapshot.id) errors.push("snapshot id does not match evidence bundle");
  if (scorecard.snapshot.type !== evidence.snapshot.type) errors.push("snapshot type does not match evidence bundle");
}

if (errors.length) {
  process.stderr.write(`Invalid scorecard:\n${errors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exit(1);
}

if (options.render) {
  const output = artifactPath(options.render);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, render(scorecard));
}
process.stdout.write(`Valid scorecard: ${scorecard.total}/100 (${scorecard.band})\n`);
