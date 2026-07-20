import test from "node:test";
import assert from "node:assert/strict";
import { aggregateRepeatedVerdicts, compareFrozenPredictions, compareLiveSnapshots } from "../eval/performance-utils.mjs";

test("repeated AI verdicts require unanimity", () => {
  assert.deepEqual(aggregateRepeatedVerdicts(["conflict", "conflict", "conflict"]), {
    verdict: "conflict", stable: true, complete: true, completedCount: 3, expectedCount: 3, counts: { conflict: 3 },
  });
  assert.deepEqual(aggregateRepeatedVerdicts(["conflict", "independent", "conflict"]), {
    verdict: "review", stable: false, complete: true, completedCount: 3, expectedCount: 3, counts: { conflict: 2, independent: 1 },
  });
  assert.deepEqual(aggregateRepeatedVerdicts(["conflict"], 3), {
    verdict: "review", stable: false, complete: false, completedCount: 1, expectedCount: 3, counts: { conflict: 1 },
  });
});

test("frozen comparison separates improvements from regressions", () => {
  const gold = [{ id: "a", gold: "conflict" }, { id: "b", gold: "harmless" }, { id: "c", gold: "conflict" }];
  const previous = [
    { id: "a", prediction: "independent" },
    { id: "b", prediction: "independent" },
    { id: "c", prediction: "conflict" },
  ];
  const current = [
    { id: "a", prediction: "conflict" },
    { id: "b", prediction: "conflict" },
    { id: "c", prediction: "conflict" },
  ];
  const result = compareFrozenPredictions(gold, previous, current);
  assert.deepEqual(result.counts, { improved: 1, regressed: 1, changed: 0, unchanged: 1, newBaseline: 0, missing: 0 });
});

test("live snapshot diff distinguishes cleared warnings from closed PRs", () => {
  const finding = (key, numbers, verdict = "conflict", input = "same") => ({
    logicalKey: key, prNumbers: numbers, verdict, basis: "test", inputFingerprint: input, findingFingerprint: verdict,
  });
  const previous = {
    generatedAt: "before",
    prs: [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }, { number: 5 }],
    findings: [finding("r#1:2", [1, 2]), finding("r#2:3", [2, 3]), finding("r#4:5", [4, 5])],
  };
  const current = {
    generatedAt: "after",
    prs: [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }],
    findings: [finding("r#1:2", [1, 2]), finding("r#2:3", [2, 3], "review"), finding("r#3:4", [3, 4])],
  };
  const result = compareLiveSnapshots(previous, current);
  assert.deepEqual(result.counts, { new: 1, changed: 1, cleared: 0, outOfScope: 1, unchanged: 1 });
});
