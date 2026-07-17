import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../benchmarks/radar-arena-v0.1/", import.meta.url));
const jsonl = async (path) => (await readFile(`${root}${path}`, "utf8")).trim().split("\n").map(JSON.parse);

test("radar arena contains two 40-PR episodes with balanced historical targets", async () => {
  const [episodeOne, episodeTwo, gold] = await Promise.all([
    readFile(`${root}episodes/episode-01.json`, "utf8").then(JSON.parse),
    readFile(`${root}episodes/episode-02.json`, "utf8").then(JSON.parse),
    jsonl("private/gold.jsonl"),
  ]);
  for (const episode of [episodeOne, episodeTwo]) {
    assert.equal(episode.prs.length, 40);
    assert.equal(episode.metadata.candidatePairCount, 780);
    assert.equal(episode.metadata.requiredOutputPairs, 20);
    assert.equal(new Set(episode.prs.map((pr) => pr.id)).size, 40);
    assert.ok(episode.prs.every((pr) => pr.files.every((file) => file.filename.startsWith("modules/m-"))));
    const episodeGold = gold.filter((record) => record.episodeId === episode.episodeId);
    assert.equal(episodeGold.length, 780);
    assert.equal(episodeGold.filter((record) => record.gold === "conflict").length, 10);
    assert.equal(episodeGold.filter((record) => record.controlType === "historical-hard-negative").length, 10);
    assert.equal(episodeGold.filter((record) => record.controlType === "isolated-module-control").length, 760);
  }
});

test("blind radar episodes do not expose source identities or gold fields", async () => {
  for (const name of ["episode-01.json", "episode-02.json"]) {
    const text = await readFile(`${root}episodes/${name}`, "utf8");
    assert.equal(text.includes("sourceCaseId"), false);
    assert.equal(text.includes("sourceRepo"), false);
    assert.equal(text.includes('"gold"'), false);
    assert.equal(text.includes("fixingCommit"), false);
  }
});
