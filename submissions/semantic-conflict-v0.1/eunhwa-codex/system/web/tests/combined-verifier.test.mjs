import test from "node:test";
import assert from "node:assert/strict";
import { classifyCombinedRuns, failureSignatures } from "../app/lib/combined-verifier.ts";

function run(label, status, signatures = []) {
  return { label, status, command: "test", exitCode: status === "passed" ? 0 : 1, durationMs: 1, failureSignatures: signatures, output: signatures.join("\n") };
}

test("combined failure is a conflict only when both individual PRs pass and the failure repeats", () => {
  const result = classifyCombinedRuns(
    run("pr_a", "passed"),
    run("pr_b", "passed"),
    run("combined", "failed", ["AssertionError: expected braille"]),
    run("combined_confirmation", "failed", ["AssertionError: expected braille"]),
  );
  assert.equal(result.verdict, "combined_conflict");
  assert.deepEqual(result.evidence, ["AssertionError: expected braille"]);
});

test("passing individual and combined trees disprove the pair conflict", () => {
  const result = classifyCombinedRuns(run("pr_a", "passed"), run("pr_b", "passed"), run("combined", "passed"));
  assert.equal(result.verdict, "combined_clean");
});

test("pre-existing individual failure is inconclusive", () => {
  const result = classifyCombinedRuns(run("pr_a", "failed"), run("pr_b", "passed"), run("combined", "failed"));
  assert.equal(result.verdict, "combined_inconclusive");
});

test("different repeated failures are inconclusive", () => {
  const result = classifyCombinedRuns(
    run("pr_a", "passed"),
    run("pr_b", "passed"),
    run("combined", "failed", ["Error: first"]),
    run("combined_confirmation", "failed", ["Error: second"]),
  );
  assert.equal(result.verdict, "combined_inconclusive");
});

test("failure signatures normalize timing and temporary paths", () => {
  assert.deepEqual(
    failureSignatures("FAIL /tmp/run-123/a.test.ts 120ms\nAssertionError: expected 1 received 2"),
    ["AssertionError: expected 1 received 2", "FAIL <tmp> <time>"],
  );
});
