import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWithAnthropic, extractJsonObject } from "../src/anthropic.mjs";
import { analyzeWithCodex } from "../src/codex.mjs";
import { classifyCombinedRuns, failureSignatures } from "../src/combined-verifier.mjs";
import { prepareIntegratedAnalysis, prepareIntentPrototypeAnalysis } from "../src/integrated.mjs";
import { buildSemanticJudgeCases, normalizeSemanticJudgments, selectSemanticJudgeCandidates } from "../src/semantic-judge.mjs";

const pr = (id, file, patch, title = `PR ${id}`) => ({ id, number: Number(id), title, baseSha: "base", files: [{ filename: file, status: "modified", patch }] });

const contractBackedJudgment = (overrides = {}) => ({
  prIds: ["1", "2"], assessment: "contract-backed-conflict", category: "api",
  title: "signature mismatch", summary: "A consumes the contract that B changes.",
  assumptionOwner: "PR-A", assumption: "old argument remains accepted",
  violatingChange: "B accepts only NewArg", preconditions: ["both PRs are merged"],
  triggerSequence: ["call newCall with oldArg"], expectedBehavior: "the call is accepted",
  possibleActualBehavior: "the combined code no longer compiles",
  contract: {
    identity: "newCall", kind: "function-signature", providerSide: "PR-B", consumerSide: "PR-A",
    providerChange: "newCall accepts NewArg", consumerDependency: "A calls newCall(oldArg)",
    composedFailure: "oldArg is rejected by the new signature",
  },
  testPlan: {
    name: "compile combined tree", strategy: "targeted-test", setup: [],
    steps: ["merge A and B", "compile Service.java"], oracle: "compilation succeeds", targetTests: [],
  },
  confidence: 0.9,
  evidenceIds: ["A-F1-L3", "B-F1-L3"],
  ...overrides,
});

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

test("identical add-vs-add helpers are an additive union, not composition risk", () => {
  const patch = "@@ -0,0 +1,3 @@\n+public final class SSLHelper {\n+  public static void configure() {}\n+}";
  const left = pr("1", "src/SSLHelper.java", patch);
  const right = pr("2", "src/SSLHelper.java", patch);
  left.files[0].status = "added";
  right.files[0].status = "added";
  const prepared = prepareIntegratedAnalysis([left, right]);
  assert.equal(prepared.comparisons[0].verdict, "independent");
  assert.ok(!prepared.comparisons[0].witnesses.some((witness) => witness.type === "add-vs-add"));
});

test("different add-vs-add definitions still require review", () => {
  const left = pr("1", "src/SSLHelper.java", "@@ -0,0 +1,1 @@\n+public final class SSLHelper { public static int mode() { return 1; } }");
  const right = pr("2", "src/SSLHelper.java", "@@ -0,0 +1,1 @@\n+public final class SSLHelper { public static int mode() { return 2; } }");
  left.files[0].status = "added";
  right.files[0].status = "added";
  const prepared = prepareIntegratedAnalysis([left, right]);
  assert.equal(prepared.comparisons[0].verdict, "review");
  assert.ok(prepared.comparisons[0].witnesses.some((witness) => witness.type === "add-vs-add"));
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

test("generic test summaries do not make unrelated failures reproducible", () => {
  assert.deepEqual(failureSignatures("1 failed"), []);
  assert.deepEqual(failureSignatures("FAIL test_a: expected true\n1 failed"), ["fail test_a: expected true"]);
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
  assert.match(cases[0].prs[0].files[0].patch, /\[A-F1-L3\] \+publishReady\(\);/);
  assert.match(cases[0].prs[1].files[0].patch, /\[B-F1-L3\] \+consumeReady\(\);/);
});

test("cross-language HTTP contracts retrieve a Python client against a Java server route", () => {
  const prepared = prepareIntegratedAnalysis([
    pr("5277", "zeppelin-mcp-server/zeppelin_mcp/client.py", [
      "@@ -0,0 +1,2 @@",
      "+payload = {\"noteId\": note_id} if note_id else None",
      "+self._request(\"PUT\", f\"/interpreter/setting/restart/{setting_id}\", json=payload)",
    ].join("\n"), "Add MCP Python client"),
    pr("5151", "zeppelin-server/src/main/java/org/apache/zeppelin/rest/InterpreterRestApi.java", [
      "@@ -10,3 +10,7 @@",
      " @PUT",
      " @Path(\"setting/restart/{settingId}\")",
      "+if (noteId == null) throw new BadRequestException(\"noteId is required\");",
      "+@PUT",
      "+@Path(\"setting/restart-all/{settingId}\")",
      "+public void restartAll(String settingId) {}",
    ].join("\n"), "Move global restart to a dedicated endpoint"),
  ]);
  const comparison = prepared.comparisons[0];
  assert.equal(comparison.retrievalFeatures.priority, 0);
  assert.ok(comparison.retrievalFeatures.sharedContracts.includes("api:http:PUT:/setting/restart/{param}"));
  assert.deepEqual(comparison.retrievalFeatures.contractFiles["api:http:PUT:/setting/restart/{param}"], {
    left: ["zeppelin-mcp-server/zeppelin_mcp/client.py"],
    right: ["zeppelin-server/src/main/java/org/apache/zeppelin/rest/InterpreterRestApi.java"],
  });
  const fileDecoys = Array.from({ length: 8 }, (_, index) => ({
    ...comparison,
    key: `decoy-${index}`,
    prIds: [`decoy-a-${index}`, `decoy-b-${index}`],
    retrievalScore: 1_000 - index,
    retrievalFeatures: {
      ...comparison.retrievalFeatures,
      sharedFiles: [`file:src/Decoy${index}.java`],
      sharedModules: [],
      sharedContracts: [],
      strongContracts: [],
    },
  }));
  prepared.comparisons = [...fileDecoys, comparison];
  const selected = selectSemanticJudgeCandidates(prepared, { primaryLimit: 0, secondLookLimit: 2 });
  assert.ok(selected.some((item) => item.key === comparison.key));
});

test("contract provenance keeps provider and consumer files beyond the fallback prefix", () => {
  const filler = Array.from({ length: 220 }, (_, index) => `+def unrelated_${index}(): return ${index}`);
  const left = {
    id: "5277", number: 5277, title: "Add MCP client", baseSha: "base",
    files: [
      ...[1, 2, 3].map((index) => ({ filename: `docs/decoy-${index}.md`, status: "modified", patch: `@@ -1 +1 @@\n-old\n+decoy ${index}` })),
      { filename: "zeppelin-mcp/src/zeppelin_mcp/client.py", status: "modified", patch: [
        "@@ -0,0 +1,221 @@", ...filler,
        "+self._request(\"PUT\", f\"/interpreter/setting/restart/{setting_id}\", json=None)",
      ].join("\n") },
    ],
  };
  const right = pr("5151", "zeppelin-server/src/main/java/org/apache/zeppelin/rest/InterpreterRestApi.java", [
    "@@ -1 +1,3 @@", " @PUT", " @Path(\"setting/restart/{settingId}\")", "+if (noteId == null) throw new BadRequestException();",
  ].join("\n"));
  const prepared = prepareIntegratedAnalysis([left, right]);
  const comparison = prepared.comparisons[0];
  const [caseInput] = buildSemanticJudgeCases(prepared, [comparison], { maxPatchChars: 700 });
  assert.deepEqual(caseInput.prs.map((item) => item.files.map((file) => file.filename)), [
    ["zeppelin-mcp/src/zeppelin_mcp/client.py"],
    ["zeppelin-server/src/main/java/org/apache/zeppelin/rest/InterpreterRestApi.java"],
  ]);
  assert.match(caseInput.prs[0].files[0].patch, /interpreter\/setting\/restart/);
  assert.match(caseInput.prs[0].files[0].patch, /\[A-F4-L222\]/);
  assert.ok(caseInput.prs[0].files[0].patch.length <= 700);
});

test("evidence-aware compaction also preserves late event contracts", () => {
  const filler = Array.from({ length: 180 }, (_, index) => `+const unrelated_${index} = ${index};`);
  const prepared = prepareIntegratedAnalysis([
    pr("1", "src/producer.js", ["@@ -0,0 +1,181 @@", ...filler, '+publish("payment.captured", payload);'].join("\n")),
    pr("2", "src/consumer.js", ["@@ -0,0 +1,181 @@", ...filler, '+subscribe("payment.captured", handlePayment);'].join("\n")),
  ]);
  const comparison = prepared.comparisons[0];
  assert.ok(comparison.retrievalFeatures.sharedContracts.includes("event:payment.captured"));
  const [caseInput] = buildSemanticJudgeCases(prepared, [comparison], { maxPatchChars: 650 });
  assert.match(caseInput.prs[0].files[0].patch, /publish\("payment\.captured"/);
  assert.match(caseInput.prs[1].files[0].patch, /subscribe\("payment\.captured"/);
});

test("AI blockers resolve immutable evidence IDs from both PRs", () => {
  const prepared = prepareIntegratedAnalysis([
    pr("1", "src/Service.java", "@@ -1 +1 @@\n-old\n+newCall(oldArg);"),
    pr("2", "src/Service.java", "@@ -2 +2 @@\n-old\n+void newCall(NewArg arg) {}"),
  ]);
  const candidates = selectSemanticJudgeCandidates(prepared);
  const base = contractBackedJudgment();
  assert.equal(normalizeSemanticJudgments(prepared, candidates, [base])[0].verdict, "conflict");
  assert.equal(normalizeSemanticJudgments(prepared, candidates, [base])[0].confirmationStatus, "contract-backed-static");
  const accepted = normalizeSemanticJudgments(prepared, candidates, [base])[0];
  assert.deepEqual(accepted.evidenceObjects.map((item) => item.quote), ["newCall(oldArg);", "void newCall(NewArg arg) {}"]);
  assert.equal(normalizeSemanticJudgments(prepared, candidates, [{ ...base, evidenceIds: base.evidenceIds.slice(0, 1) }])[0].verdict, "review");
  assert.equal(normalizeSemanticJudgments(prepared, candidates, [{ ...base, evidenceIds: ["A-F99-L99", "B-F1-L3"] }])[0].verdict, "review");
  assert.equal(normalizeSemanticJudgments(prepared, candidates, [{
    ...base,
    evidenceIds: undefined,
    evidence: [
      { side: "A", file: "src/Service.java", symbol: "newCall", quote: "newCall(oldArg);" },
      { side: "B", file: "src/Service.java", symbol: "newCall", quote: "void newCall(NewArg arg) {}" },
    ],
  }])[0].verdict, "review");
});

test("Anthropic adapter repairs control characters and uses the shared evidence gate", async () => {
  assert.deepEqual(extractJsonObject('prefix {"quote":"a\tb"} suffix'), { quote: "a\tb" });
  assert.deepEqual(extractJsonObject('```json\n{"assessment":"independent","detail":"brace } in string"}\n```\nusage: {"tokens":42}'), {
    assessment: "independent", detail: "brace } in string",
  });
  const prepared = prepareIntegratedAnalysis([
    pr("1", "src/Service.java", "@@ -1 +1 @@\n-old\n+newCall(oldArg);"),
    pr("2", "src/Service.java", "@@ -2 +2 @@\n-old\n+void newCall(NewArg arg) {}"),
  ]);
  const client = { messages: { create: async () => ({ content: [{ type: "text", text: JSON.stringify(contractBackedJudgment()) }] }) } };
  const judgments = await analyzeWithAnthropic(prepared, { client, concurrency: 1 });
  assert.equal(judgments[0].verdict, "conflict");
  assert.equal(judgments[0].source, "anthropic");
});

test("Codex adapter uses the same second-look and bilateral evidence contract", async () => {
  const prepared = prepareIntegratedAnalysis([
    pr("1", "src/Service.java", "@@ -1 +1 @@\n-old\n+newCall(oldArg);"),
    pr("2", "src/Service.java", "@@ -2 +2 @@\n-old\n+void newCall(NewArg arg) {}"),
  ]);
  const runner = async (caseInput) => contractBackedJudgment({ prIds: caseInput.prIds });
  const judgments = await analyzeWithCodex(prepared, { runner, concurrency: 1 });
  assert.equal(judgments[0].verdict, "conflict");
  assert.equal(judgments[0].source, "codex");
});

test("Codex receives a stable CASE_JSON and returns a stable compatible verdict across three runs", async () => {
  const prepared = prepareIntegratedAnalysis([
    pr("1", "src/SSLHelper.java", "@@ -0,0 +1,1 @@\n+public final class SSLHelper {}"),
    pr("2", "src/SSLHelper.java", "@@ -0,0 +1,1 @@\n+public final class SSLHelper {}"),
  ]);
  const seen = [];
  const runner = async (caseInput) => {
    seen.push(JSON.stringify(caseInput));
    return {
      prIds: caseInput.prIds, verdict: "compatible", category: "code", title: "identical helper",
      summary: "Both parents add the same helper.", assumptionA: "", assumptionB: "", failureMechanism: "",
      recommendation: "merge", confidence: 1, evidence: [],
    };
  };
  const verdicts = [];
  for (let run = 0; run < 3; run += 1) {
    const [judgment] = await analyzeWithCodex(prepared, { runner, concurrency: 1 });
    verdicts.push(judgment.verdict);
  }
  assert.deepEqual(new Set(seen).size, 1);
  assert.deepEqual(verdicts, ["independent", "independent", "independent"]);
});
