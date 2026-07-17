#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareIntegratedAnalysis } from "../src/integrated.mjs";
import { normalizeSemanticJudgments, selectSemanticJudgeCandidates } from "../src/semantic-judge.mjs";

const [
  inputsArg = "handoff/semantic-conflict-pair-judgment-v0.1/inputs.jsonl",
  claudeArg = "../submissions/semantic-conflict-v0.1/springmin-claude/pair-qualification-predictions.jsonl",
  outputArg = "benchmarks/comparisons/integrated-v0.2-claude-frozen/pair",
] = process.argv.slice(2);

async function readJsonl(path) {
  return (await readFile(resolve(path), "utf8")).split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
}

const inputs = await readJsonl(inputsArg);
const claude = new Map((await readJsonl(claudeArg)).map((prediction) => [prediction.id, prediction]));
const predictions = [];

for (const record of inputs) {
  const prepared = prepareIntegratedAnalysis(record.prs);
  const deterministic = prepared.comparisons[0];
  const frozen = claude.get(record.id);
  const candidates = selectSemanticJudgeCandidates(prepared);
  const ai = frozen ? normalizeSemanticJudgments(prepared, candidates, [{ ...frozen, prIds: deterministic.prIds }], {
    source: "anthropic-frozen-submission",
    basis: "anthropic-semantic-judgment-v0.2",
  })[0] : null;
  const resolved = deterministic.verdict === "conflict" && deterministic.basis === "deterministic-witness"
    ? deterministic : ai || deterministic;
  predictions.push({
    schemaVersion: "pair-qualification-prediction-v0.1",
    id: record.id,
    prediction: resolved.verdict,
    confidence: resolved.confidence ?? 0.8,
    assumptionA: resolved.assumptionA || "",
    assumptionB: resolved.assumptionB || "",
    failureMechanism: resolved.consequence || "",
    explanation: resolved.summary || "",
    evidence: resolved.evidenceObjects || [],
    latencyMs: 0,
    tokens: 0,
    costUsd: 0,
  });
}

const output = resolve(outputArg);
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(join(output, "predictions.jsonl"), `${predictions.map((row) => JSON.stringify(row)).join("\n")}\n`),
  writeFile(join(output, "run.json"), `${JSON.stringify({
    schemaVersion: "pair-qualification-run-v0.1",
    systemName: "integrated-v0.2-claude-frozen",
    version: "integrated-v0.2",
    model: "deterministic+retrieval+frozen-claude-opus-4-8-second-look",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    totalLatencyMs: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    failedCases: 0,
    notes: "Fusion-policy regression only. Claude judgments are the teammate's frozen submission, not fresh API calls. Do not use latency or generalization claims from this run.",
  }, null, 2)}\n`),
]);
console.log(`Frozen Claude fusion: ${predictions.length} cases → ${output}`);
