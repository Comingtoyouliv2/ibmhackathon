import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHumanAnswerTemplate,
  buildPromotionCandidate,
  evaluateCandidateGate,
  mergePromotions,
  resolveHumanAnswers,
} from "../eval/improvement-lifecycle.mjs";

test("human questions become explicit answer contracts", () => {
  const questions = [{ id: "q1", caseId: "case", question: "lane?" }, { id: "q2", kind: "coordination-policy", question: "verify?" }];
  const template = buildHumanAnswerTemplate(questions);
  assert.deepEqual(template[0].allowedDecisions, ["conflict", "harmless", "retry", "skip"]);
  const result = resolveHumanAnswers(questions, [{ questionId: "q1", decision: "conflict", note: "checked" }]);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.pending.length, 1);

  const invalid = resolveHumanAnswers(
    [{ id: "q3", kind: "cleared-warning-review", question: "regression?" }],
    [{ questionId: "q3", decision: "conflict" }],
  );
  assert.equal(invalid.resolved.length, 0);
  assert.match(invalid.errors[0], /allowed: expected, regression, skip/);
});

test("candidate gate rejects missing predictions and blocker downgrades", () => {
  const blockerDowngrade = evaluateCandidateGate({
    goldRecords: [{ id: "a", gold: "conflict" }],
    baselinePredictions: [{ id: "a", prediction: "conflict" }],
    candidatePredictions: [{ id: "a", prediction: "review" }],
    targetCaseIds: ["a"], testsPassed: true,
  });
  assert.equal(blockerDowngrade.passed, false);
  assert.match(blockerDowngrade.reasons.join(" "), /blocker-regressions:a/);

  const missing = evaluateCandidateGate({
    goldRecords: [{ id: "a", gold: "conflict" }, { id: "b", gold: "harmless" }],
    baselinePredictions: [{ id: "a", prediction: "conflict" }, { id: "b", prediction: "independent" }],
    candidatePredictions: [{ id: "a", prediction: "conflict" }],
    targetCaseIds: ["a"], testsPassed: true,
  });
  assert.equal(missing.passed, false);
  assert.match(missing.reasons.join(" "), /deterministic-missing:1/);
});

test("candidate gate rejects regressions and unresolved targets", () => {
  const result = evaluateCandidateGate({
    goldRecords: [{ id: "a", gold: "conflict" }, { id: "b", gold: "harmless" }],
    baselinePredictions: [{ id: "a", prediction: "independent" }, { id: "b", prediction: "independent" }],
    candidatePredictions: [{ id: "a", prediction: "conflict" }, { id: "b", prediction: "conflict" }],
    targetCaseIds: ["a"], testsPassed: true,
  });
  assert.equal(result.passed, false);
  assert.match(result.reasons.join(" "), /deterministic-regressions:1/);
});

test("only executable verified live cases become deduplicated benchmark candidates", () => {
  const candidate = buildPromotionCandidate({
    repository: "acme/repo",
    input: { prs: [{ id: "a" }, { id: "b" }] },
    finding: { category: "api" },
    verification: {
      baseSha: "base", headShaA: "a", headShaB: "b", combinedTreeSha: "tree", verifiedAt: "2026-07-19T00:00:00Z",
      classification: { verdict: "conflict", rationale: "A+B fails twice", evidence: ["same failure"] },
    },
    humanDecision: "conflict",
  });
  assert.equal(candidate.gold.gold, "conflict");
  const merged = mergePromotions([], [], [candidate, candidate]);
  assert.equal(merged.added, 1);
});

test("executable verification still requires human causal approval before gold promotion", () => {
  const common = {
    repository: "acme/repo",
    input: { prs: [{ id: "a" }, { id: "b" }] },
    finding: { category: "api" },
    verification: {
      baseSha: "base", headShaA: "a", headShaB: "b", verifiedAt: "2026-07-19T00:00:00Z",
      classification: { verdict: "conflict", rationale: "A+B fails twice", evidence: ["same failure"] },
    },
  };
  assert.equal(buildPromotionCandidate(common), null);
  assert.equal(buildPromotionCandidate({ ...common, humanDecision: "harmless" }), null);
  assert.equal(buildPromotionCandidate({ ...common, humanDecision: "conflict" }).gold.gold, "conflict");
});
