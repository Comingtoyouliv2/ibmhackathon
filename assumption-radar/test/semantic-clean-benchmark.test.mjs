import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../benchmarks/semantic-clean-v0.1/frozen-v0.1/", import.meta.url));
const readJsonl = async (name) => (await readFile(`${root}${name}`, "utf8")).trim().split("\n").map(JSON.parse);

test("frozen semantic benchmark contains 20 clean positives and 20 hard negatives", async () => {
  const gold = await readJsonl("gold.jsonl");
  assert.equal(gold.length, 40);
  assert.equal(new Set(gold.map((record) => record.id)).size, 40);
  assert.equal(gold.filter((record) => record.gold === "conflict").length, 20);
  assert.equal(gold.filter((record) => record.gold === "harmless").length, 20);
  assert.equal(new Set(gold.map((record) => record.repo)).size, 33);
  assert.ok(gold.every((record) => record.mechanicalMerge === "clean"));
  assert.ok(gold.every((record) => record.semanticBenchmarkEligibility === "included"));
  assert.ok(gold.every((record) => record.evidenceGrade === "contract-backed"));
  assert.ok(gold.filter((record) => record.gold === "conflict").every((record) => record.fixingCommit));
});

test("frozen benchmark inputs and versioned predictions cover every gold case", async () => {
  const [gold, inputs, v05Predictions, v06Predictions, v07Predictions, v08Predictions] = await Promise.all([
    readJsonl("gold.jsonl"), readJsonl("inputs.jsonl"),
    readJsonl("predictions-v0.5.0.jsonl"), readJsonl("predictions-v0.6.0.jsonl"),
    readJsonl("predictions-v0.7.0.jsonl"),
    readJsonl("predictions-v0.8.0.jsonl"),
  ]);
  const ids = gold.map((record) => record.id).sort();
  assert.deepEqual(inputs.map((record) => record.id).sort(), ids);
  assert.deepEqual(v05Predictions.map((record) => record.id).sort(), ids);
  assert.deepEqual(v06Predictions.map((record) => record.id).sort(), ids);
  assert.deepEqual(v07Predictions.map((record) => record.id).sort(), ids);
  assert.deepEqual(v08Predictions.map((record) => record.id).sort(), ids);
  assert.ok(inputs.every((record) => record.prs.length === 2));
  assert.ok(inputs.every((record) => record.prs.every((pr) => pr.baseSha && pr.headSha && pr.files.length)));
  assert.ok([...v05Predictions, ...v06Predictions, ...v07Predictions, ...v08Predictions].every((record) => ["conflict", "coordination", "review", "independent", "insufficient"].includes(record.prediction)));
});
