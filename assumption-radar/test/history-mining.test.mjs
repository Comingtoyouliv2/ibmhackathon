import test from "node:test";
import assert from "node:assert/strict";
import { isLikelyFix, mineHistoryCandidates, referencedPullRequests, touchesLanguage } from "../src/history-mining.mjs";
import { changedOldRanges, pullNumberFromSubject } from "../src/history-lineage.mjs";
import { classifyLineageSides, isFixSubject, isSourcePath, mergeFixEvidence } from "../src/merge-history.mjs";

const file = (filename) => ({ filename, status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" });
const pr = (number, title, mergedAt, files, body = "") => ({
  id: String(number), number, title, body, author: "dev", url: `https://example.test/pull/${number}`,
  mergedAt, headSha: `head-${number}`, baseSha: "base", mergeCommitSha: `merge-${number}`, base: "main", files,
});

test("history miner identifies fix anchors, prior pairs, and matched controls", () => {
  const merged = [
    pr(30, "BUG regression after #10 and #20", "2026-03-01T00:00:00Z", [file("pkg/core.py"), file("tests/test_core.py")]),
    pr(20, "Refactor consumer", "2026-02-15T00:00:00Z", [file("pkg/core.py")]),
    pr(10, "Change producer", "2026-02-01T00:00:00Z", [file("tests/test_core.py")]),
    pr(40, "Unrelated same-file improvement", "2026-01-25T00:00:00Z", [file("pkg/other.py")]),
    pr(41, "Another same-file improvement", "2026-01-20T00:00:00Z", [file("pkg/other.py")]),
  ];
  const result = mineHistoryCandidates("acme/repo", merged, { fixWindowDays: 90, candidateLimit: 10, controlCount: 10 });
  assert.equal(result.fixes.length, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].caseId, "acme/repo#10x20-fix-30");
  assert.deepEqual(result.candidates[0].evidence.fixReferences, [10, 20]);
  assert.equal(result.controls.length, 1);
  assert.deepEqual(result.controls[0].causes.map((item) => item.number), [40, 41]);
});

test("history helper distinguishes fix language and explicit PR references", () => {
  const item = pr(30, "Fix crash from #123", "2026-03-01T00:00:00Z", [file("pkg/core.py")], "Also relates to #456.");
  assert.equal(isLikelyFix(item), true);
  assert.deepEqual(referencedPullRequests(item), [123, 456]);
  assert.equal(touchesLanguage(item, "python"), true);
  assert.equal(touchesLanguage(item, "typescript"), false);
  assert.equal(isLikelyFix(pr(31, "ENH improve parser", "2026-03-02T00:00:00Z", [file("pkg/core.py")], "Fixes #999")), false);
  assert.equal(isLikelyFix(pr(32, "ENH improve parser", "2026-03-03T00:00:00Z", [file("pkg/core.py")], "Regression introduced by #999")), true);
  assert.equal(isLikelyFix(pr(33, "[backport] BUG fix parser", "2026-03-04T00:00:00Z", [file("pkg/core.py")], "Backport of #32")), false);
});

test("history miner rejects an arbitrary same-file partner without fix-level causal surface", () => {
  const customFile = (patch) => ({ filename: "pkg/core.py", status: "modified", patch });
  const cause = pr(1, "ENH parser", "2026-01-01T00:00:00Z", [customFile("@@ -10 +10 @@ def parse():\n-old()\n+new()")]);
  const unrelated = pr(2, "ENH renderer", "2026-01-02T00:00:00Z", [customFile("@@ -80 +80 @@ def render():\n-old()\n+new()")]);
  const fix = pr(3, "BUG parser regression", "2026-01-03T00:00:00Z", [customFile("@@ -11 +11 @@ def parse():\n-new()\n+safe()")], "Follows up on #1");
  const mined = mineHistoryCandidates("acme/repo", [cause, unrelated, fix], { candidateLimit: 10, controlCount: 1 });
  assert.equal(mined.candidates.length, 0);
});

test("history lineage extracts source ranges and squash PR subjects", () => {
  const diff = "diff --git a/pkg/core.py b/pkg/core.py\n@@ -10,3 +10,2 @@ def parse():\n-old\n+new\ndiff --git a/tests/test_core.py b/tests/test_core.py\n@@ -1 +1 @@\n-old\n+new";
  assert.deepEqual(changedOldRanges(diff), [{ path: "pkg/core.py", start: 10, end: 12 }]);
  assert.equal(pullNumberFromSubject("BUG repair parser (#1234)"), 1234);
  assert.equal(pullNumberFromSubject("BUG repair parser"), null);
});

test("merge-history helpers keep source fixes and reject generated artifacts", () => {
  assert.equal(isFixSubject("Fix parser regression after merge"), true);
  assert.equal(isFixSubject("Merge pull request #123\n\nFix parser regression after merge"), true);
  assert.equal(isFixSubject("Backport fix parser regression"), false);
  assert.equal(isSourcePath("src/parser.ts"), true);
  assert.equal(isSourcePath("requirements/static/windows.lock"), false);
  assert.equal(isSourcePath("tests/test_parser.py"), false);
  const evidence = mergeFixEvidence(
    ["src/producer.ts", "src/shared.ts"],
    ["src/consumer.ts", "src/shared.ts"],
    ["src/producer.ts", "src/consumer.ts", "tests/shared.test.ts"],
  );
  assert.equal(evidence.strength, "both-side-source-surfaces");
  assert.deepEqual(evidence.overlapA, ["src/producer.ts"]);
  assert.deepEqual(evidence.overlapB, ["src/consumer.ts"]);
  assert.equal(classifyLineageSides([
    { sha: "base", inBase: true, inA: true, inB: true },
    { sha: "a", inBase: false, inA: true, inB: false },
    { sha: "b", inBase: false, inA: false, inB: true },
  ]).strength, "both-parent-lineage");
  assert.equal(classifyLineageSides([
    { sha: "b", inBase: false, inA: false, inB: true },
  ]).strength, "single-parent-lineage");
  assert.equal(classifyLineageSides([
    { sha: "base", inBase: true, inA: true, inB: true },
  ]).strength, "insufficient");
});
