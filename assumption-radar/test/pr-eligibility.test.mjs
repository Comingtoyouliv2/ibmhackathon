import test from "node:test";
import assert from "node:assert/strict";
import {
  partitionEligiblePullRequests,
  summarizeCommitChecks,
} from "../src/pr-eligibility.mjs";
import { fetchCommitChecks } from "../src/github.mjs";

test("commit checks distinguish failed, pending, passed, and unknown heads", () => {
  assert.equal(summarizeCommitChecks([{ name: "build", status: "completed", conclusion: "failure" }]).status, "failed");
  assert.equal(summarizeCommitChecks([{ name: "build", status: "in_progress", conclusion: null }]).status, "pending");
  assert.equal(summarizeCommitChecks([{ name: "build", status: "completed", conclusion: "success" }]).status, "passed");
  assert.equal(summarizeCommitChecks([]).status, "unknown");
  assert.equal(summarizeCommitChecks([{ name: "build", status: "completed", conclusion: "timed_out" }]).status, "unknown");
  assert.equal(summarizeCommitChecks([], { state: "error", total_count: 1 }).status, "unknown");
});

test("only the latest run of a named check controls eligibility", () => {
  const status = summarizeCommitChecks([
    { id: 1, name: "build", status: "completed", conclusion: "failure", completed_at: "2026-07-20T00:00:00Z" },
    { id: 2, name: "build", status: "completed", conclusion: "success", completed_at: "2026-07-21T00:00:00Z" },
  ]);
  assert.equal(status.status, "passed");
  assert.deepEqual(status.failedChecks, []);
});

test("unavailable GitHub check metadata degrades to unknown instead of aborting analysis", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"message":"forbidden"}', { status: 403 });
  try {
    const result = await fetchCommitChecks("owner/repo", "head-sha", "token");
    assert.equal(result.status, "unknown");
    assert.equal(result.lookup, "unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("draft and failed-CI pull requests never enter pair generation", () => {
  const result = partitionEligiblePullRequests([
    { number: 1, headSha: "a", draft: false, ci: { status: "passed" } },
    { number: 2, headSha: "b", draft: true, ci: { status: "passed" } },
    { number: 3, headSha: "c", draft: false, ci: { status: "failed", failedChecks: ["compile"] } },
    { number: 4, headSha: "d", draft: false, ci: { status: "pending" } },
  ]);
  assert.deepEqual(result.eligible.map((pr) => pr.number), [1, 4]);
  assert.deepEqual(result.excluded.map((pr) => [pr.number, pr.reasonCode]), [[2, "draft-pr"], [3, "failed-ci"]]);
  assert.deepEqual(result.summary, { fetched: 4, eligible: 2, excluded: 2, draft: 1, failedCi: 1 });
});
