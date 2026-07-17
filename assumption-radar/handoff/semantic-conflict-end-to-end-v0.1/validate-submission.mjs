#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const DECISIONS = new Set(["conflict", "review", "independent", "insufficient", "coordination"]);
const [episodesArg = "episodes", predictionsArg = "radar-arena-predictions.jsonl", runArg = "radar-arena-run.json"] = process.argv.slice(2);

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

const pairKey = (a, b) => [a, b].sort().join(":");

async function main() {
  const episodesDir = resolve(episodesArg);
  const names = (await readdir(episodesDir)).filter((name) => /^episode-\d+\.json$/.test(name)).sort();
  const episodes = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(episodesDir, name), "utf8"))));
  const [predictions, run, taskPrompt] = await Promise.all([
    readJsonl(resolve(predictionsArg)),
    readFile(resolve(runArg), "utf8").then(JSON.parse),
    readFile(new URL("./TASK_PROMPT.txt", import.meta.url), "utf8"),
  ]);
  const errors = [];
  const episodeById = new Map(episodes.map((episode) => [episode.episodeId, episode]));

  for (const episode of episodes) {
    const rows = predictions.filter((record) => record.episodeId === episode.episodeId).sort((a, b) => a.rank - b.rank);
    const validPrIds = new Set(episode.prs.map((pr) => pr.id));
    if (rows.length !== episode.metadata.requiredOutputPairs) {
      errors.push(`${episode.episodeId}: expected ${episode.metadata.requiredOutputPairs} predictions, got ${rows.length}`);
    }
    const pairs = new Set();
    rows.forEach((record, index) => {
      const prefix = `${episode.episodeId} rank ${index + 1}`;
      if (record.schemaVersion !== "radar-arena-prediction-v0.1") errors.push(`${prefix}: invalid schemaVersion`);
      if (record.rank !== index + 1) errors.push(`${prefix}: ranks must be contiguous from 1 to 20`);
      if (!validPrIds.has(record.prA) || !validPrIds.has(record.prB)) errors.push(`${prefix}: unknown PR id`);
      if (record.prA === record.prB) errors.push(`${prefix}: a PR cannot be paired with itself`);
      const key = pairKey(record.prA, record.prB);
      if (pairs.has(key)) errors.push(`${prefix}: duplicate pair ${key}`);
      pairs.add(key);
      if (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) errors.push(`${prefix}: confidence must be 0..1`);
      if (!DECISIONS.has(record.decision)) errors.push(`${prefix}: invalid decision '${record.decision}'`);
      if (typeof record.explanation !== "string" || !record.explanation.trim()) errors.push(`${prefix}: explanation is required`);
    });
  }

  const unknownEpisodes = predictions.filter((record) => !episodeById.has(record.episodeId));
  if (unknownEpisodes.length) errors.push(`${unknownEpisodes.length} predictions reference unknown episodes`);
  const expectedPromptHash = createHash("sha256").update(taskPrompt).digest("hex");
  if (run.schemaVersion !== "radar-arena-run-v0.1") errors.push("run.json: invalid schemaVersion");
  if (run.taskPromptSha256 !== expectedPromptHash) errors.push(`run.json: taskPromptSha256 mismatch (expected ${expectedPromptHash})`);
  for (const field of ["systemName", "version", "model", "startedAt", "finishedAt"]) {
    if (typeof run[field] !== "string" || !run[field].trim()) errors.push(`run.json: ${field} is required`);
  }
  if (!Number.isFinite(run.totalLatencyMs) || run.totalLatencyMs < 0) errors.push("run.json: totalLatencyMs must be non-negative");
  if (!Number.isInteger(run.failedEpisodes) || run.failedEpisodes < 0) errors.push("run.json: failedEpisodes must be a non-negative integer");

  if (errors.length) throw new Error(errors.slice(0, 50).join("\n"));
  console.log(`Submission valid: ${episodes.length} episodes, ${predictions.length} ranked pairs.`);
  console.log(`Task prompt SHA-256: ${expectedPromptHash}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
