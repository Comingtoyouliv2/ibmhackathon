import assert from "node:assert/strict";
import test from "node:test";
import { stabilizeGateSnapshot } from "../app/lib/github.ts";

const checks = { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] };

function pr(number, headRefOid, mergeable = "UNKNOWN") {
  return {
    number,
    title: `PR ${number}`,
    url: `https://example.test/${number}`,
    isDraft: false,
    mergeable,
    headRefOid,
    baseRefOid: "base-1",
    commits: checks,
  };
}

test("mergeability stabilization keeps the initial PR number snapshot", () => {
  const stabilized = stabilizeGateSnapshot(
    [pr(1, "head-1"), pr(2, "head-2")],
    [pr(1, "head-1", "MERGEABLE"), pr(2, "head-2", "MERGEABLE"), pr(3, "head-3", "MERGEABLE")],
  );
  assert.deepEqual(stabilized.map((entry) => entry.number), [1, 2]);
  assert.deepEqual(stabilized.map((entry) => entry.mergeable), ["MERGEABLE", "MERGEABLE"]);
});

test("a head SHA change during stabilization is marked stale", () => {
  const [stale] = stabilizeGateSnapshot([pr(1, "head-old")], [pr(1, "head-new", "MERGEABLE")]);
  assert.equal(stale.headRefOid, "head-old");
  assert.equal(stale.mergeable, "UNKNOWN");
  assert.equal(stale.snapshotStale, true);
});
