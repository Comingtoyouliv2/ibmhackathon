import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { evaluateRecords, readJsonl, validateRecords, wilsonInterval } from "../eval/evaluate.mjs";

const fixture = fileURLToPath(new URL("./fixtures/evaluator-smoke.jsonl", import.meta.url));

test("rubric evaluator separates triage, blocker, and abstention quality", async () => {
  const result = evaluateRecords(await readJsonl(fixture));
  assert.deepEqual({ tp: result.blocker.tp, fp: result.blocker.fp, tn: result.blocker.tn, fn: result.blocker.fn }, { tp: 1, fp: 1, tn: 3, fn: 3 });
  assert.equal(result.blocker.precision, 0.5);
  assert.equal(result.blocker.recall, 0.25);
  assert.equal(result.routing.triageRecall, 0.75);
  assert.equal(result.routing.harmlessReviewRate, 0.25);
  assert.equal(result.routing.decisiveCoverage, 0.5);
  assert.equal(result.routing.selectiveAccuracy, 0.75);
  assert.equal(result.routing.insufficientRate, 0.125);
});

test("evidence and operations metrics use only annotated samples", async () => {
  const result = evaluateRecords(await readJsonl(fixture));
  assert.equal(result.evidence.annotated, 6);
  assert.equal(result.evidence.validWitnessRate, 5 / 6);
  assert.equal(result.evidence.exactWitnessRate, 2 / 6);
  assert.equal(result.operations.latencyP50Ms, 100);
  assert.equal(result.operations.latencyP95Ms, 400);
});

test("invalid labels fail loudly", () => {
  assert.throws(() => validateRecords([{ id: "x", gold: "maybe", prediction: "review" }]), /invalid gold/);
});

test("Wilson interval is bounded and defined for non-empty samples", () => {
  const interval = wilsonInterval(9, 10);
  assert.ok(interval.low > 0 && interval.low < 0.9);
  assert.ok(interval.high > 0.9 && interval.high <= 1);
});

test("detector metrics expose coverage, noise, and unique contribution", async () => {
  const result = evaluateRecords(await readJsonl(fixture));
  const detector = result.detectors["same-declaration"];
  assert.equal(detector.activations, 2);
  assert.equal(detector.conflictCoverage, 0.25);
  assert.equal(detector.harmlessActivationRate, 0.25);
  assert.equal(detector.uniqueConflictContribution, 1);
  assert.equal(detector.reviewConflict, 1);
  assert.equal(detector.reviewHarmless, 1);
});

test("mechanical coordination records are excluded from semantic metrics", async () => {
  const records = await readJsonl(fixture);
  records.push({
    id: "mechanical",
    gold: "conflict",
    prediction: "coordination",
    semanticBenchmarkEligibility: "excluded",
  });
  const result = evaluateRecords(records);
  assert.equal(result.dataset.total, 9);
  assert.equal(result.dataset.evaluated, 8);
  assert.equal(result.dataset.excluded, 1);
  assert.equal(result.routing.triageRecall, 0.75);
});
