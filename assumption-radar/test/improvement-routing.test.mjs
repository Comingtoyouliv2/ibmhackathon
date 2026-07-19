import test from "node:test";
import assert from "node:assert/strict";
import { routeFrozenFailures, routeLiveDiff } from "../eval/improvement-routing.mjs";

test("verified deterministic benchmark errors become code actions", () => {
  const result = routeFrozenFailures({
    goldRecords: [{ id: "case-1", gold: "conflict", archetype: "remove-vs-reference" }],
    predictions: [{ id: "case-1", prediction: "independent" }],
    errorLedger: [{ id: "case-1", rootCause: "missing-remove-vs-reference-dependency-rule", recommendedExperiment: "add detector" }],
  });
  assert.equal(result.codeActions.length, 1);
  assert.equal(result.promptActions.length, 0);
  assert.deepEqual(result.codeActions[0].targetFiles, ["src/adapters/java.mjs", "src/analyzer.mjs"]);
});

test("unstable AI benchmark errors ask for repeat judgment", () => {
  const result = routeFrozenFailures({
    goldRecords: [{ id: "case-1", gold: "conflict" }],
    predictions: [{ id: "case-1", prediction: "independent", source: "codex", repeatVerdicts: ["independent", "conflict"] }],
  });
  assert.equal(result.codeActions.length, 0);
  assert.equal(result.humanQuestions[0].kind, "unstable-or-unrepeated-ai-error");
});

test("an unstable AI verdict asks a human even when triage matches gold", () => {
  const result = routeFrozenFailures({
    goldRecords: [{ id: "case-1", gold: "conflict" }],
    predictions: [{ id: "case-1", prediction: "review", source: "codex", repeatStable: false, repeatVerdicts: ["conflict", "review", "conflict"] }],
  });
  assert.equal(result.humanQuestions.length, 1);
  assert.equal(result.humanQuestions[0].kind, "unstable-ai-verdict");
});

test("live warnings route to verification and coordination is grouped for humans", () => {
  const result = routeLiveDiff({
    repository: "acme/repo",
    snapshot: {},
    diff: {
      new: [
        { logicalKey: "acme/repo#1:2", prNumbers: [1, 2], verdict: "conflict", basis: "deterministic-witness", source: "framework", inputFingerprint: "a" },
        { logicalKey: "acme/repo#2:3", prNumbers: [2, 3], verdict: "coordination", basis: "merge-tree-textual-conflict", source: "git-preflight", inputFingerprint: "b" },
      ],
      changed: [], cleared: [],
    },
  });
  assert.equal(result.verificationActions.length, 1);
  assert.equal(result.humanQuestions.length, 1);
  assert.equal(result.humanQuestions[0].kind, "coordination-policy");
});
