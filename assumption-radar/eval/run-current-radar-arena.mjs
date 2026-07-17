#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { prepareAnalysis } from "../src/analyzer.mjs";

const [
  episodesArg = "benchmarks/radar-arena-v0.1/episodes",
  outputArg = "benchmarks/radar-arena-v0.1/baselines/assumption-radar-v0.9.0",
] = process.argv.slice(2);
const episodesDir = resolve(episodesArg);
const outputDir = resolve(outputArg);

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

function confidence(comparison) {
  if (comparison.verdict === "conflict") return comparison.causalAnalysis?.status === "contradiction" ? 0.98 : 0.86;
  if (comparison.verdict === "review") return 0.68;
  if (comparison.verdict === "coordination") return 0.9;
  if (comparison.verdict === "independent") return comparison.witnesses?.length ? 0.5 : 0.25;
  return 0.1;
}

async function main() {
  const names = (await readdir(episodesDir)).filter((name) => /^episode-\d+\.json$/.test(name)).sort();
  if (!names.length) throw new Error(`no episodes in ${episodesDir}`);
  const startedAt = new Date();
  const totalStarted = performance.now();
  const predictions = [];
  const episodeRuns = [];

  for (const name of names) {
    const episode = JSON.parse(await readFile(join(episodesDir, name), "utf8"));
    const started = performance.now();
    const prepared = prepareAnalysis(episode.prs);
    const elapsed = performance.now() - started;
    const top = prepared.comparisons.slice(0, episode.metadata.requiredOutputPairs);
    top.forEach((comparison, index) => predictions.push({
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
  const taskPrompt = await readFile(join(dirname(episodesDir), "TASK_PROMPT.txt"), "utf8");
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, "predictions.jsonl"), jsonl(predictions)),
    writeFile(join(outputDir, "run.json"), `${JSON.stringify({
      schemaVersion: "radar-arena-run-v0.1",
      systemName: "assumption-radar",
      version: "0.9.0",
      model: "deterministic-heuristics+SCIR",
      taskPromptSha256: createHash("sha256").update(taskPrompt).digest("hex"),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      totalLatencyMs,
      totalTokens: 0,
      totalCostUsd: 0,
      failedEpisodes: 0,
      episodeRuns,
      notes: "Current deterministic v0.9 ranks every pair by verdict and witness strength without AI calls.",
    }, null, 2)}\n`),
  ]);
  console.log(`Current Radar arena run complete: ${outputDir}`);
  console.log(`${names.length} episodes · ${predictions.length} ranked pairs · ${totalLatencyMs.toFixed(1)} ms`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
