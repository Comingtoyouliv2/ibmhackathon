#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { prepareAnalysis } from "../src/analyzer.mjs";
import { prepareIntegratedAnalysis, prepareIntentPrototypeAnalysis } from "../src/integrated.mjs";

const [system, track, ...argv] = process.argv.slice(2);
const options = {};
for (let index = 0; index < argv.length; index += 1) {
  const key = argv[index];
  const value = argv[++index];
  if (!value || !["--suite", "--output"].includes(key)) throw new Error(`invalid argument: ${key}`);
  options[key.slice(2)] = resolve(value);
}
if (!['current', 'team2', 'integrated'].includes(system) || !['pair', 'radar'].includes(track) || !options.suite || !options.output) {
  console.error("Usage: node eval/run-local-system.mjs <current|team2|integrated> <pair|radar> --suite DIR --output DIR");
  process.exit(1);
}

const prepare = system === "integrated" ? prepareIntegratedAnalysis : system === "team2" ? prepareIntentPrototypeAnalysis : prepareAnalysis;
const version = system === "integrated" ? "integrated-v0.1" : system === "team2" ? "intent-resource-prototype-v0.1" : "assumption-radar-v0.9.0";
const model = system === "integrated" ? "deterministic+SCIR+patch-effects+intent-retrieval" : system === "team2" ? "intent-resource-retrieval-only" : "deterministic-heuristics+SCIR";
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

async function readJsonl(path) {
  return (await readFile(path, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
}

function changedEvidence(pr, side) {
  for (const file of pr.files || []) {
    const quote = (file.patch || "").split("\n").find((line) => /^\+(?!\+)/.test(line) && line.slice(1).trim());
    if (quote) return { side, file: file.filename, symbol: "", quote: quote.slice(1) };
  }
  return null;
}

function confidence(comparison) {
  if (comparison.verdict === "conflict") return 0.98;
  if (comparison.verdict === "review") return comparison.basis === "intent-resource-retrieval-prototype" ? 0.45 : 0.68;
  if (comparison.verdict === "independent") return comparison.retrievalScore > 0 ? 0.6 : 0.9;
  return 0.25;
}

function pairPrediction(record, comparison, latencyMs) {
  return {
    schemaVersion: "pair-qualification-prediction-v0.1",
    id: record.id,
    prediction: comparison.verdict,
    confidence: confidence(comparison),
    assumptionA: comparison.assumptionA || "",
    assumptionB: comparison.assumptionB || "",
    failureMechanism: comparison.consequence || comparison.summary || "",
    explanation: comparison.summary || comparison.title || "No pair-induced contradiction was established.",
    evidence: [changedEvidence(record.prs[0], "A"), changedEvidence(record.prs[1], "B")].filter(Boolean),
    latencyMs,
    tokens: 0,
    costUsd: 0,
  };
}

async function runPair() {
  const inputPath = join(options.suite, "inputs.jsonl");
  const records = await readJsonl(inputPath);
  const startedAt = new Date();
  const totalStarted = performance.now();
  const predictions = records.map((record) => {
    const started = performance.now();
    const comparison = prepare(record.prs).comparisons[0];
    return pairPrediction(record, comparison, performance.now() - started);
  });
  const promptPath = join(options.suite, "SYSTEM_PROMPT.txt");
  const promptHash = createHash("sha256").update(await readFile(promptPath)).digest("hex");
  const totalLatencyMs = performance.now() - totalStarted;
  const run = {
    schemaVersion: "pair-qualification-run-v0.1", systemName: system, version, model, promptSha256: promptHash,
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), totalLatencyMs,
    totalTokens: 0, totalCostUsd: 0, failedCases: 0,
    notes: system === "team2"
      ? "Runnable prototype of the design-stage Intent Card/resource retrieval. It has no implemented Step-3 semantic judge, so related pairs are routed to review rather than conflict."
      : "Local deterministic run on the frozen suite.",
  };
  await mkdir(options.output, { recursive: true });
  await Promise.all([
    writeFile(join(options.output, "predictions.jsonl"), jsonl(predictions)),
    writeFile(join(options.output, "run.json"), `${JSON.stringify(run, null, 2)}\n`),
  ]);
  console.log(`${system} pair run: ${predictions.length} cases · ${totalLatencyMs.toFixed(1)} ms`);
}

async function runRadar() {
  const episodesDir = join(options.suite, "episodes");
  const names = (await readdir(episodesDir)).filter((name) => /^episode-\d+\.json$/.test(name)).sort();
  const startedAt = new Date();
  const totalStarted = performance.now();
  const predictions = [];
  const episodeRuns = [];
  for (const name of names) {
    const episode = JSON.parse(await readFile(join(episodesDir, name), "utf8"));
    const started = performance.now();
    const prepared = prepare(episode.prs);
    const elapsed = performance.now() - started;
    prepared.comparisons.slice(0, episode.metadata.requiredOutputPairs).forEach((comparison, index) => predictions.push({
      schemaVersion: "radar-arena-prediction-v0.1",
      episodeId: episode.episodeId,
      prA: comparison.prIds[0],
      prB: comparison.prIds[1],
      rank: index + 1,
      confidence: confidence(comparison),
      decision: comparison.verdict,
      explanation: comparison.summary,
    }));
    episodeRuns.push({ episodeId: episode.episodeId, prCount: episode.prs.length, pairCount: prepared.comparisons.length, latencyMs: elapsed });
  }
  const totalLatencyMs = performance.now() - totalStarted;
  const taskHash = createHash("sha256").update(await readFile(join(options.suite, "TASK_PROMPT.txt"))).digest("hex");
  const run = {
    schemaVersion: "radar-arena-run-v0.1", systemName: system, version, model, taskPromptSha256: taskHash,
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), totalLatencyMs,
    totalTokens: 0, totalCostUsd: 0, failedEpisodes: 0, episodeRuns,
    notes: system === "team2" ? "Intent/resource retrieval prototype; ranking only, without the planned LLM pair judge." : "Local deterministic run on the frozen arena.",
  };
  await mkdir(options.output, { recursive: true });
  await Promise.all([
    writeFile(join(options.output, "predictions.jsonl"), jsonl(predictions)),
    writeFile(join(options.output, "run.json"), `${JSON.stringify(run, null, 2)}\n`),
  ]);
  console.log(`${system} radar run: ${names.length} episodes · ${predictions.length} pairs · ${totalLatencyMs.toFixed(1)} ms`);
}

if (track === "pair") await runPair();
else await runRadar();
