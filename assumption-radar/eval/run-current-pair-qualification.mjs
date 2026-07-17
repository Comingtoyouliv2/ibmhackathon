#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { prepareAnalysis } from "../src/analyzer.mjs";

const [
  inputArg = "handoff/semantic-conflict-pair-judgment-v0.1/inputs.jsonl",
  outputArg = "benchmarks/comparisons/pair-qualification-v0.1/assumption-radar-v0.9.0",
] = process.argv.slice(2);

const inputPath = resolve(inputArg);
const outputDir = resolve(outputArg);

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

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

async function suitePromptHash() {
  const suiteDir = dirname(inputPath);
  try {
    return (await readFile(join(suiteDir, "PROMPT_SHA256.txt"), "utf8")).trim();
  } catch {
    try {
      const [system, template] = await Promise.all([
        readFile(join(suiteDir, "SYSTEM_PROMPT.txt"), "utf8"),
        readFile(join(suiteDir, "USER_PROMPT_TEMPLATE.txt"), "utf8"),
      ]);
      return createHash("sha256").update(`${system}\n${template}`).digest("hex");
    } catch {
      return createHash("sha256").update("deterministic-no-prompt").digest("hex");
    }
  }
}

function changedLines(pr) {
  return (pr.files || []).flatMap((file) => (file.patch || "").split("\n")
    .filter((line) => /^[+-](?![+-])/.test(line) && line.slice(1).trim())
    .map((line) => ({ file: file.filename, quote: line.slice(1) })));
}

function witnessCandidates(comparison) {
  const strength = { direct: 3, semantic: 2, weak: 1 };
  return (comparison.witnesses || [])
    .slice()
    .sort((a, b) => (strength[b.strength] || 0) - (strength[a.strength] || 0))
    .flatMap((witness) => (witness.evidence || []).map((quote) => ({
      quote,
      symbol: witness.title || witness.type || "",
      score: (strength[witness.strength] || 0) * 1000 + String(quote).length,
    })))
    .filter((item) => typeof item.quote === "string" && item.quote.trim());
}

function locateQuote(pr, quote) {
  return (pr.files || []).find((file) =>
    file.filename?.includes(quote) || file.previousFilename?.includes(quote) || file.patch?.includes(quote));
}

function evidenceForSide(comparison, pr, side) {
  const matching = witnessCandidates(comparison)
    .map((item) => ({ ...item, file: locateQuote(pr, item.quote)?.filename }))
    .filter((item) => item.file)
    .sort((a, b) => b.score - a.score);
  const selected = matching[0];
  if (selected) {
    return { side, file: selected.file, symbol: selected.symbol, quote: selected.quote };
  }

  const fallback = changedLines(pr).sort((a, b) => b.quote.length - a.quote.length)[0];
  if (!fallback) return null;
  return { side, file: fallback.file, symbol: "", quote: fallback.quote };
}

function confidenceFor(comparison) {
  if (comparison.verdict === "conflict") {
    return comparison.causalAnalysis?.status === "contradiction" ? 0.98 : 0.86;
  }
  if (comparison.verdict === "review") return 0.68;
  if (comparison.verdict === "independent") {
    return comparison.witnesses?.length ? 0.78 : 0.92;
  }
  if (comparison.verdict === "coordination") return 0.95;
  return 0.5;
}

function toSubmission(caseRecord, comparison, latencyMs) {
  const needsBothSides = ["conflict", "review", "coordination"].includes(comparison.verdict);
  const evidence = [
    evidenceForSide(comparison, caseRecord.prs[0], "A"),
    evidenceForSide(comparison, caseRecord.prs[1], "B"),
  ].filter(Boolean);
  return {
    schemaVersion: "pair-qualification-prediction-v0.1",
    id: caseRecord.id,
    prediction: comparison.verdict,
    confidence: confidenceFor(comparison),
    assumptionA: comparison.assumptionA || "",
    assumptionB: comparison.assumptionB || "",
    failureMechanism: comparison.consequence || comparison.summary || "",
    explanation: comparison.summary || comparison.title || "No pair-induced contradiction was established.",
    evidence: needsBothSides ? evidence : evidence.slice(0, 2),
    latencyMs,
    tokens: 0,
    costUsd: 0,
  };
}

async function main() {
  const cases = await readJsonl(inputPath);
  const startedAt = new Date();
  const started = performance.now();
  const predictions = [];

  for (const caseRecord of cases) {
    const caseStarted = performance.now();
    const prepared = prepareAnalysis(caseRecord.prs);
    const comparison = prepared.comparisons[0];
    if (!comparison) throw new Error(`${caseRecord.id}: analyzer produced no comparison`);
    predictions.push(toSubmission(caseRecord, comparison, performance.now() - caseStarted));
  }

  const totalLatencyMs = performance.now() - started;
  const promptSha256 = await suitePromptHash();
  const run = {
    schemaVersion: "pair-qualification-run-v0.1",
    systemName: "assumption-radar",
    version: "0.9.0",
    model: "deterministic-heuristics+SCIR",
    promptSha256,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    totalLatencyMs,
    totalTokens: 0,
    totalCostUsd: 0,
    failedCases: 0,
    notes: "Current v0.9 deterministic analyzer. It makes no AI calls, so the frozen AI prompt is recorded as the protocol version but is not invoked.",
  };

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDir, "predictions.jsonl"), jsonl(predictions)),
    writeFile(resolve(outputDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`),
  ]);
  console.log(`Current Radar qualification complete: ${outputDir}`);
  console.log(`${predictions.length} cases · ${totalLatencyMs.toFixed(1)} ms · 0 tokens · $0`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
