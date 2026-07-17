#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [
  inputArg = "benchmarks/semantic-clean-v0.1/frozen-v0.1/inputs.jsonl",
  goldArg = "benchmarks/semantic-clean-v0.1/frozen-v0.1/gold.jsonl",
  outputArg = "benchmarks/radar-arena-v0.1",
] = process.argv.slice(2);

const outputRoot = resolve(outputArg);
const EPISODE_COUNT = 2;
const CASES_PER_CLASS = 10;

async function readJsonl(path) {
  const text = await readFile(resolve(path), "utf8");
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
}

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const pairKey = (episodeId, a, b) => `${episodeId}:${[a, b].sort().join(":")}`;

function seededRandom(seedText) {
  let state = Number.parseInt(digest(seedText).slice(0, 8), 16) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function shuffled(values, random) {
  const result = values.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function prefixPatch(patch, prefix) {
  return String(patch || "")
    .replace(/^diff --git a\/(.+) b\/(.+)$/gm, (_, oldPath, newPath) => `diff --git a/${prefix}${oldPath} b/${prefix}${newPath}`)
    .replace(/^--- a\/(.+)$/gm, (_, path) => `--- a/${prefix}${path}`)
    .replace(/^\+\+\+ b\/(.+)$/gm, (_, path) => `+++ b/${prefix}${path}`)
    .replace(/^(rename|copy) from (.+)$/gm, (_, operation, path) => `${operation} from ${prefix}${path}`)
    .replace(/^(rename|copy) to (.+)$/gm, (_, operation, path) => `${operation} to ${prefix}${path}`);
}

function anonymizePr(pr, { episodeId, moduleId, prId, number, baseSha }) {
  const prefix = `modules/${moduleId}/`;
  return {
    id: prId,
    number,
    title: `Change set ${String(number).padStart(3, "0")}`,
    url: `arena://${episodeId}/${prId}`,
    headSha: digest(`${episodeId}:${prId}:head`).slice(0, 40),
    baseSha,
    files: (pr.files || []).map((file) => ({
      ...file,
      filename: `${prefix}${file.filename}`,
      ...(file.previousFilename ? { previousFilename: `${prefix}${file.previousFilename}` } : {}),
      patch: prefixPatch(file.patch, prefix),
    })),
  };
}

async function main() {
  const [inputs, gold] = await Promise.all([readJsonl(inputArg), readJsonl(goldArg)]);
  const inputById = new Map(inputs.map((record) => [record.id, record]));
  const cases = gold.map((record) => {
    const input = inputById.get(record.id);
    if (!input || input.prs?.length !== 2) throw new Error(`${record.id}: missing two-PR input`);
    return { gold: record, prs: input.prs };
  });
  const positives = shuffled(cases.filter((item) => item.gold.gold === "conflict"), seededRandom("arena-positive-v0.1"));
  const negatives = shuffled(cases.filter((item) => item.gold.gold === "harmless"), seededRandom("arena-negative-v0.1"));
  if (positives.length !== 20 || negatives.length !== 20) throw new Error("arena requires 20 conflict and 20 harmless source pairs");

  const episodes = [];
  const allGold = [];
  const mapping = [];
  for (let episodeIndex = 0; episodeIndex < EPISODE_COUNT; episodeIndex += 1) {
    const episodeId = `radar-arena-v0.1-episode-${String(episodeIndex + 1).padStart(2, "0")}`;
    const random = seededRandom(episodeId);
    const selected = shuffled([
      ...positives.slice(episodeIndex * CASES_PER_CLASS, (episodeIndex + 1) * CASES_PER_CLASS),
      ...negatives.slice(episodeIndex * CASES_PER_CLASS, (episodeIndex + 1) * CASES_PER_CLASS),
    ], random);
    const baseSha = digest(`${episodeId}:base`).slice(0, 40);
    const pendingPrs = [];

    selected.forEach((item, caseIndex) => {
      const moduleId = `m-${digest(`${episodeId}:${caseIndex}:${item.gold.id}`).slice(0, 10)}`;
      item.prs.forEach((pr, sideIndex) => pendingPrs.push({ item, pr, sideIndex, moduleId }));
    });

    const orderedPrs = shuffled(pendingPrs, random);
    const sourceByPr = new Map();
    const prs = orderedPrs.map((entry, prIndex) => {
      const prId = `PR-${String(prIndex + 1).padStart(3, "0")}`;
      sourceByPr.set(prId, entry);
      mapping.push({
        schemaVersion: "radar-arena-mapping-v0.1",
        episodeId,
        prId,
        moduleId: entry.moduleId,
        side: entry.sideIndex === 0 ? "A" : "B",
        sourceCaseId: entry.item.gold.id,
        sourceRepo: entry.item.gold.repo,
        sourcePrId: entry.pr.id,
      });
      return anonymizePr(entry.pr, { episodeId, moduleId: entry.moduleId, prId, number: prIndex + 1, baseSha });
    });

    for (let left = 0; left < prs.length; left += 1) {
      for (let right = left + 1; right < prs.length; right += 1) {
        const a = prs[left].id;
        const b = prs[right].id;
        const sourceA = sourceByPr.get(a);
        const sourceB = sourceByPr.get(b);
        const sameCase = sourceA.item.gold.id === sourceB.item.gold.id;
        const sourceGold = sameCase ? sourceA.item.gold : null;
        allGold.push({
          schemaVersion: "radar-arena-gold-v0.1",
          id: pairKey(episodeId, a, b),
          episodeId,
          prA: a,
          prB: b,
          gold: sameCase ? sourceGold.gold : "harmless",
          controlType: sameCase
            ? (sourceGold.gold === "conflict" ? "historical-conflict" : "historical-hard-negative")
            : "isolated-module-control",
          sourceCaseId: sameCase ? sourceGold.id : null,
          sourceRepo: sameCase ? sourceGold.repo : null,
          language: sameCase ? sourceGold.language : "mixed-java",
          archetype: sameCase ? sourceGold.archetype : "isolated-module-control",
          evidenceGrade: sameCase ? sourceGold.evidenceGrade : "construction-backed",
        });
      }
    }

    episodes.push({
      schemaVersion: "radar-arena-episode-v0.1",
      episodeId,
      repository: "assumption-radar/federated-monorepo-arena",
      baseSha,
      allowedInformation: "patches-only",
      metadata: {
        prCount: prs.length,
        candidatePairCount: (prs.length * (prs.length - 1)) / 2,
        requiredOutputPairs: 20,
      },
      prs,
    });
  }

  const episodesDir = join(outputRoot, "episodes");
  const privateDir = join(outputRoot, "private");
  await Promise.all([mkdir(episodesDir, { recursive: true }), mkdir(privateDir, { recursive: true })]);
  await Promise.all([
    ...episodes.map((episode, index) => writeFile(join(episodesDir, `episode-${String(index + 1).padStart(2, "0")}.json`), `${JSON.stringify(episode)}\n`)),
    writeFile(join(privateDir, "gold.jsonl"), jsonl(allGold)),
    writeFile(join(privateDir, "mapping.jsonl"), jsonl(mapping)),
    writeFile(join(outputRoot, "run.json"), `${JSON.stringify({
      schemaVersion: "radar-arena-build-v0.1",
      generatedAt: new Date().toISOString(),
      episodes: episodes.length,
      prsPerEpisode: episodes.map((episode) => episode.prs.length),
      candidatePairs: allGold.length,
      positives: allGold.filter((record) => record.gold === "conflict").length,
      historicalHardNegatives: allGold.filter((record) => record.controlType === "historical-hard-negative").length,
      isolatedModuleControls: allGold.filter((record) => record.controlType === "isolated-module-control").length,
    }, null, 2)}\n`),
  ]);
  console.log(`Radar arena built: ${outputRoot}`);
  console.log(`${episodes.length} episodes · ${episodes[0].prs.length} PR each · ${allGold.length} pairs · ${allGold.filter((record) => record.gold === "conflict").length} conflicts`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
