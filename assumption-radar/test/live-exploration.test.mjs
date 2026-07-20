import test from "node:test";
import assert from "node:assert/strict";
import { buildExecutionProfiles, buildLiveErrorLedger, planLiveVerification, selectExplorationControls } from "../eval/live-exploration.mjs";

const pr = (id) => ({ id: String(id), number: Number(id), headSha: `head-${id}`, baseSha: "base", base: "main", url: `https://example.test/${id}` });
const comparison = (left, right, priority, score = 0) => ({
  key: `${left}:${right}`,
  prIds: [String(left), String(right)],
  verdict: "independent",
  basis: "relevance-only",
  source: "framework",
  retrievalScore: score,
  retrievalReasons: [`priority:${priority}`],
  retrievalFeatures: { priority },
});

test("no-alert exploration is deterministic, stratified, and excludes existing findings", () => {
  const comparisons = [
    comparison(1, 2, 0, 100),
    comparison(1, 3, 0, 90),
    comparison(1, 4, 0, 80),
    comparison(2, 3, 1, 50),
    comparison(3, 4, 2, 20),
    comparison(4, 5, 3, 0),
  ];
  const options = {
    repository: "acme/repo",
    comparisons,
    prs: [1, 2, 3, 4, 5].map(pr),
    findingKeys: ["1:2"],
    stacks: [{ ancestorId: "1", descendantId: "3" }],
    limit: 4,
  };
  const first = selectExplorationControls(options);
  const second = selectExplorationControls(options);
  assert.deepEqual(first, second);
  assert.equal(first.some((item) => item.logicalKey === "acme/repo#1:2"), false);
  assert.equal(first.some((item) => item.logicalKey === "acme/repo#1:3"), false);
  assert.deepEqual(new Set(first.map((item) => item.samplingStratum)), new Set([
    "same-file-or-contract", "same-module", "weak-symbol-or-intent", "random-no-overlap",
  ]));
});

test("live execution produces actionable false-negative and scoped false-positive records", () => {
  const verification = (verdict) => ({
    baseSha: "base", headShaA: "a", headShaB: "b", verifiedAt: "2026-07-20T00:00:00Z",
    classification: { verdict, evidence: verdict === "conflict" ? ["same repeated failure"] : ["all pass"] },
  });
  const ledger = buildLiveErrorLedger([
    {
      repository: "acme/repo",
      action: { logicalKey: "acme/repo#1:2", exploration: true, predictedVerdict: "independent", samplingStratum: "random-no-overlap" },
      finding: { logicalKey: "acme/repo#1:2", verdict: "independent" },
      verification: verification("conflict"),
    },
    {
      repository: "acme/repo",
      action: { logicalKey: "acme/repo#2:3" },
      finding: { logicalKey: "acme/repo#2:3", verdict: "review" },
      verification: verification("compatible"),
    },
    {
      repository: "acme/repo",
      action: { logicalKey: "acme/repo#3:4" },
      finding: { logicalKey: "acme/repo#3:4", verdict: "conflict" },
      verification: verification("excluded"),
    },
  ]);
  assert.deepEqual(ledger.map((item) => item.errorType), ["false-negative", "false-positive-candidate"]);
  assert.equal(ledger[0].pipelineStage, "candidate-retrieval");
  assert.match(ledger[0].rootCause, /missed-no-alert/);
});

function allPairs(count) {
  const pairs = [];
  let index = 0;
  for (let left = 1; left <= count; left += 1) {
    for (let right = left + 1; right <= count; right += 1) {
      pairs.push(comparison(left, right, index % 4, 100 - index));
      index += 1;
    }
  }
  return pairs;
}

test("auto policy pilots before runtime is measured and exhausts a small measured repository", () => {
  const common = { repository: "acme/repo", comparisons: allPairs(5), prs: [1, 2, 3, 4, 5].map(pr) };
  const pilot = planLiveVerification(common);
  assert.equal(pilot.mode, "pilot");
  assert.equal(pilot.reason, "execution-time-not-measured");
  assert.equal(pilot.controls.length, 4);

  const exhaustive = planLiveVerification({
    ...common,
    executionProfile: { medianBaseMs: 1_000, medianSingleMs: 1_000, medianCombinedMs: 1_000 },
  });
  assert.equal(exhaustive.mode, "exhaustive");
  assert.equal(exhaustive.eligibleCleanPairCount, 10);
  assert.equal(exhaustive.controls.length, 10);
  assert.equal(exhaustive.estimatedTotalMs, 16_000);
});

test("auto policy uses a 70/20/10 budget when pair count or runtime is too large", () => {
  const policy = planLiveVerification({
    repository: "acme/repo",
    comparisons: allPairs(12),
    prs: Array.from({ length: 12 }, (_, index) => pr(index + 1)),
    executionProfile: { medianBaseMs: 1_000, medianSingleMs: 1_000, medianCombinedMs: 1_000 },
    pairLimit: 20,
    budgetedLimit: 10,
  });
  assert.equal(policy.mode, "budgeted");
  assert.equal(policy.reason, "pair-count-exceeds-limit");
  assert.equal(policy.controls.length, 10);
  const strata = policy.controls.reduce((counts, item) => counts.set(item.samplingStratum, (counts.get(item.samplingStratum) || 0) + 1), new Map());
  assert.equal((strata.get("same-file-or-contract") || 0) + (strata.get("same-module") || 0), 7);
  assert.equal(strata.get("weak-symbol-or-intent"), 2);
  assert.equal(strata.get("random-no-overlap"), 1);

  const slow = planLiveVerification({
    repository: "acme/repo",
    comparisons: allPairs(5),
    prs: [1, 2, 3, 4, 5].map(pr),
    executionProfile: { medianBaseMs: 60_000, medianSingleMs: 60_000, medianCombinedMs: 60 * 60_000 },
    timeBudgetMs: 2 * 60 * 60_000,
  });
  assert.equal(slow.mode, "budgeted");
  assert.equal(slow.reason, "estimated-runtime-exceeds-budget");
});

test("execution profile measures uncached Base, single PR, and combined work", () => {
  const profiles = buildExecutionProfiles([{
    repository: "acme/repo",
    verification: { runs: [
      { label: "base", durationMs: 100 },
      { label: "a", durationMs: 200 },
      { label: "b", durationMs: 400 },
      { label: "combined", durationMs: 500 },
      { label: "combined_confirmation", durationMs: 600 },
      { label: "a", durationMs: 9_999, cached: true },
    ] },
  }], "2026-07-20T00:00:00Z");
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].medianBaseMs, 100);
  assert.equal(profiles[0].medianSingleMs, 300);
  assert.equal(profiles[0].medianCombinedMs, 1_100);
  assert.deepEqual(profiles[0].samples, { base: 1, single: 2, combined: 1 });
});
