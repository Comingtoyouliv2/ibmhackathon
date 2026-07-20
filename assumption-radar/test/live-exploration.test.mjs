import test from "node:test";
import assert from "node:assert/strict";
import { buildLiveErrorLedger, selectExplorationControls } from "../eval/live-exploration.mjs";

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
