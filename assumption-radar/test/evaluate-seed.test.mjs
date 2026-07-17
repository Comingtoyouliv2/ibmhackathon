import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSeed, validateSeedRecords } from "../eval/evaluate-seed.mjs";

const gold = [
  { id: "stack", repository: "x/y", pullRequests: [{ number: 1 }, { number: 2 }], goldRelationship: "compatible", relationshipBenchmarkEligibility: "excluded", semanticBenchmarkEligibility: "excluded" },
  { id: "coord", repository: "x/y", pullRequests: [{ number: 2 }, { number: 3 }], goldRelationship: "coordination-required", goldCoordinationSubtype: "duplicate-implementation", goldRequiredAction: "deduplicate", relationshipBenchmarkEligibility: "included", semanticBenchmarkEligibility: "excluded" },
  { id: "hard-negative", repository: "x/y", pullRequests: [{ number: 4 }, { number: 5 }], goldRelationship: "compatible", relationshipBenchmarkEligibility: "included", semanticBenchmarkEligibility: "included" },
];

const predictions = [
  { id: "stack", disposition: "filtered", filterReason: "stack-ancestor-suppressed" },
  { id: "coord", disposition: "analyzed", predictedRelationship: "coordination", predictedCoordinationSubtype: null, predictedRequiredAction: "resolve-textual-conflict" },
  { id: "hard-negative", disposition: "analyzed", predictedRelationship: "review" },
];

test("seed evaluator separates filtering, relationship, subtype, and silent semantic quality", () => {
  const result = evaluateSeed(gold, predictions);
  assert.equal(result.filtering.recall, 1);
  assert.equal(result.relationship.accuracy, 0.5);
  assert.equal(result.coordination.recall, 1);
  assert.equal(result.coordination.subtypeAccuracy, 0);
  assert.equal(result.silentSemantic.harmlessReviewRate, 1);
  assert.deepEqual(result.errors, [{ id: "hard-negative", expected: "compatible", actual: "review" }]);
  assert.deepEqual(result.explanationGaps, [
    { id: "coord", dimension: "coordination-subtype", expected: "duplicate-implementation", actual: "missing" },
    { id: "coord", dimension: "required-action", expected: "deduplicate", actual: "resolve-textual-conflict" },
  ]);
});

test("seed evaluator rejects missing and unknown predictions", () => {
  assert.throws(() => validateSeedRecords(gold, predictions.slice(1)), /missing prediction/);
  assert.throws(() => validateSeedRecords(gold, [...predictions, { id: "unknown", disposition: "filtered" }]), /unknown id/);
});
