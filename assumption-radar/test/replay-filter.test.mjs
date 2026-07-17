import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCandidateFamilies, candidateFamilyKey, classifyReplay, closingIssueNumbers,
  filterReplayFamilies, pullNumberFromMergeMessage, closingIssueReferences,
} from "../src/replay-filter.mjs";

const states = (base, a, b, combined, fixed) => ({
  base: { outcome: base, observable: true }, a: { outcome: a }, b: { outcome: b },
  combined: { outcome: combined }, fixed: { outcome: fixed },
});

const candidate = (caseId, merge, fix, lineage = ["cause"]) => ({
  caseId, repository: "acme/repo",
  merge: { commit: merge, epoch: 100 }, fixingCommit: { commit: fix, epoch: 110 },
  evidence: { lineage: { strength: "single-parent-lineage", sideACommits: lineage, sideBCommits: [] } },
});

test("counterfactual matrix distinguishes pair conflicts and attribution controls", () => {
  const pair = classifyReplay({ pairScope: "independent-prs", states: states("pass", "pass", "pass", "fail", "pass") });
  assert.equal(pair.classification, "pair-induced-conflict");
  assert.equal(pair.pairBenchmarkEligible, true);
  const single = classifyReplay({ pairScope: "independent-prs", states: states("pass", "pass", "fail", "fail", "pass") });
  assert.equal(single.classification, "single-parent-b-bug");
  assert.equal(single.historyMinerControl, true);
  assert.equal(single.pairBenchmarkEligible, false);
  const preexisting = classifyReplay({ states: states("fail", "fail", "fail", "fail", "pass") });
  assert.equal(preexisting.classification, "pre-existing-defect");
});

test("unobservable base failure abstains instead of hiding a possible exposure conflict", () => {
  const result = classifyReplay({ states: { ...states("fail", "pass", "pass", "fail", "pass"), base: { outcome: "fail", observable: false } } });
  assert.equal(result.classification, "insufficient");
  assert.equal(result.reason, "base-logic-fails-but-user-reachability-unproven");
});

test("a matching issue predating both PRs is an automatic pre-existing gate", () => {
  const result = classifyReplay({
    causes: [{ id: "A", createdAt: "2026-07-01" }, { id: "B", createdAt: "2026-07-02" }],
    issueReports: [{ number: 1, reportedAt: "2026-06-24", explicitlyLinked: true, symptomMatches: true }],
    states: {},
  });
  assert.equal(result.classification, "pre-existing-defect");
  assert.equal(result.reason, "matching-issue-predates-both-causes");
});

test("candidate families collapse duplicate merge records sharing fix and lineage", () => {
  const left = candidate("case-a", "merge-a", "fix", ["origin"]);
  const right = candidate("case-b", "merge-b", "fix", ["origin"]);
  right.merge.epoch = 105;
  const families = buildCandidateFamilies([left, right]);
  assert.equal(families.length, 1);
  assert.equal(families[0].representative.caseId, "case-b");
  assert.deepEqual(families[0].aliases, ["case-a"]);
  assert.equal(candidateFamilyKey(left), candidateFamilyKey(right));
  const filtered = filterReplayFamilies([left, right], [{ caseId: "case-a", states: states("pass", "pass", "pass", "pass", "pass") }]);
  assert.equal(filtered[0].decision.classification, "compatible");
});

test("GitHub timeline evidence merges with explicit counterfactual states", () => {
  const item = candidate("case-a", "merge-a", "fix", ["origin"]);
  const familyKey = candidateFamilyKey(item);
  const filtered = filterReplayFamilies([item], [
    {
      familyKey,
      source: "github-timeline-enrichment",
      pairScope: "independent-prs",
      causes: [{ id: "A", createdAt: "2026-07-01" }, { id: "B", createdAt: "2026-07-02" }],
      issueReports: [{ number: 7, reportedAt: "2026-06-24", explicitlyLinked: true, symptomMatches: true }],
    },
    { familyKey, source: "manual-replay", states: states("fail", "fail", "fail", "fail", "pass") },
  ]);
  assert.equal(filtered[0].decision.classification, "pre-existing-defect");
  assert.equal(filtered[0].decision.reason, "matching-issue-predates-both-causes");
  assert.deepEqual(filtered[0].decision.evidence.sources.sort(), ["github-timeline-enrichment", "manual-replay"]);
});

test("GitHub references distinguish PR merge numbers and explicitly closed issues", () => {
  assert.equal(pullNumberFromMergeMessage("Merge pull request #123 from acme/fix\nFix parser"), 123);
  assert.equal(pullNumberFromMergeMessage("Fix parser (#456)"), 456);
  assert.deepEqual(closingIssueNumbers("Fixes #12, resolves acme/repo#34; related #99"), [12, 34]);
  assert.deepEqual(closingIssueNumbers("Fixes https://github.com/microsoft/vscode/issues/322792"), [322792]);
  assert.deepEqual(closingIssueReferences("fix https://github.com/microsoft/vscode-engineering/issues/3250", "microsoft/vscode"), [
    { repository: "microsoft/vscode-engineering", number: 3250 },
  ]);
});
