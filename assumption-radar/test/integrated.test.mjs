import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWithAnthropic, extractJsonObject } from "../src/anthropic.mjs";
import { analyzeWithCodex } from "../src/codex.mjs";
import { classifyCombinedRuns, failureSignatures } from "../src/combined-verifier.mjs";
import { prepareIntegratedAnalysis, prepareIntentPrototypeAnalysis } from "../src/integrated.mjs";
import { buildSemanticJudgeCases, normalizeSemanticJudgments, selectSemanticJudgeCandidates } from "../src/semantic-judge.mjs";

const pr = (id, file, patch, title = `PR ${id}`) => ({ id, number: Number(id), title, baseSha: "base", files: [{ filename: file, status: "modified", patch }] });

test("intent retrieval ranks same-module pairs above isolated pairs without inventing blocker verdicts", () => {
  const prs = [
    pr("1", "modules/a/src/Service.java", "@@ -1 +1 @@\n-old()\n+newer()"),
    pr("2", "modules/a/src/Other.java", "@@ -1 +1 @@\n-before()\n+after()"),
    pr("3", "modules/b/src/Else.java", "@@ -1 +1 @@\n-left()\n+right()"),
  ];
  const prepared = prepareIntentPrototypeAnalysis(prs);
  assert.deepEqual(new Set(prepared.comparisons[0].prIds), new Set(["1", "2"]));
  assert.equal(prepared.comparisons[0].verdict, "review");
});

test("patch write-read interaction improves retrieval without inventing a semantic verdict", () => {
  const prepared = prepareIntegratedAnalysis([
    pr("1", "src/Cache.java", "@@ -10 +10 @@\n-old\n+cache.setReady(true);"),
    pr("2", "src/Cache.java", "@@ -20 +20 @@\n-old\n+if (cache.getReady()) { return; }"),
  ]);
  assert.equal(prepared.comparisons[0].verdict, "independent");
  assert.ok(prepared.comparisons[0].witnesses.some((witness) => witness.type === "patch-write-read"));
  assert.ok(prepared.comparisons[0].retrievalScore > 0);
});

test("combined verifier requires independent passes and a repeated failure signature", () => {
  const result = classifyCombinedRuns({
    base: { status: "passed" }, a: { status: "passed" }, b: { status: "passed" },
    combined: { status: "failed", output: "error[E100]: missing field 12" },
    confirmation: { status: "failed", output: "error[E100]: missing field 99" },
  });
  assert.equal(result.verdict, "conflict");
  assert.deepEqual(failureSignatures("panic at 0xabc line 42"), ["panic at 0x# line #"]);
});

test("semantic judge adds a bounded second look for related independent pairs", () => {
  const prepared = prepareIntegratedAnalysis([
    pr("1", "modules/a/src/Producer.java", "@@ -1 +1 @@\n-old\n+publishReady();"),
    pr("2", "modules/a/src/Consumer.java", "@@ -1 +1 @@\n-old\n+consumeReady();"),
  ]);
  assert.equal(prepared.comparisons[0].verdict, "independent");
  const selected = selectSemanticJudgeCandidates(prepared);
  assert.equal(selected.length, 1);
  const cases = buildSemanticJudgeCases(prepared, selected);
  assert.equal(cases[0].reviewLane, "second-look");
  assert.deepEqual(cases[0].prs.map((item) => item.files.length), [1, 1]);
});

test("AI blockers require verbatim evidence from both PRs", () => {
  const prepared = prepareIntegratedAnalysis([
    pr("1", "src/Service.java", "@@ -1 +1 @@\n-old\n+newCall(oldArg);"),
    pr("2", "src/Service.java", "@@ -2 +2 @@\n-old\n+void newCall(NewArg arg) {}"),
  ]);
  const candidates = selectSemanticJudgeCandidates(prepared);
  const base = {
    prIds: ["1", "2"], verdict: "conflict", failureMechanism: "A adds an old-argument call while B replaces the accepted argument type.",
    evidence: [
      { side: "A", file: "src/Service.java", symbol: "newCall", quote: "newCall(oldArg);" },
      { side: "B", file: "src/Service.java", symbol: "newCall", quote: "void newCall(NewArg arg) {}" },
    ],
  };
  assert.equal(normalizeSemanticJudgments(prepared, candidates, [base])[0].verdict, "conflict");
  assert.equal(normalizeSemanticJudgments(prepared, candidates, [{ ...base, evidence: base.evidence.slice(0, 1) }])[0].verdict, "review");
});

test("Anthropic adapter repairs control characters and uses the shared evidence gate", async () => {
  assert.deepEqual(extractJsonObject('prefix {"quote":"a\tb"} suffix'), { quote: "a\tb" });
  const prepared = prepareIntegratedAnalysis([
    pr("1", "src/Service.java", "@@ -1 +1 @@\n-old\n+newCall(oldArg);"),
    pr("2", "src/Service.java", "@@ -2 +2 @@\n-old\n+void newCall(NewArg arg) {}"),
  ]);
  const client = { messages: { create: async () => ({ content: [{ type: "text", text: JSON.stringify({
    prIds: ["1", "2"], verdict: "conflict", failureMechanism: "old argument no longer accepted", evidence: [
      { side: "A", file: "src/Service.java", symbol: "newCall", quote: "newCall(oldArg);" },
      { side: "B", file: "src/Service.java", symbol: "newCall", quote: "void newCall(NewArg arg) {}" },
    ],
  }) }] }) } };
  const judgments = await analyzeWithAnthropic(prepared, { client, concurrency: 1 });
  assert.equal(judgments[0].verdict, "conflict");
  assert.equal(judgments[0].source, "anthropic");
});

test("Codex adapter uses the same second-look and bilateral evidence contract", async () => {
  const prepared = prepareIntegratedAnalysis([
    pr("1", "src/Service.java", "@@ -1 +1 @@\n-old\n+newCall(oldArg);"),
    pr("2", "src/Service.java", "@@ -2 +2 @@\n-old\n+void newCall(NewArg arg) {}"),
  ]);
  const runner = async (caseInput) => ({
    prIds: caseInput.prIds,
    verdict: "conflict",
    category: "api",
    title: "signature mismatch",
    summary: "A uses the old contract while B replaces it.",
    assumptionA: "old argument remains accepted",
    assumptionB: "only NewArg is accepted",
    failureMechanism: "the combined call no longer compiles",
    recommendation: "update the callsite",
    confidence: 0.9,
    evidence: [
      { side: "A", file: "src/Service.java", symbol: "newCall", quote: "newCall(oldArg);" },
      { side: "B", file: "src/Service.java", symbol: "newCall", quote: "void newCall(NewArg arg) {}" },
    ],
  });
  const judgments = await analyzeWithCodex(prepared, { runner, concurrency: 1 });
  assert.equal(judgments[0].verdict, "conflict");
  assert.equal(judgments[0].source, "codex");
});
