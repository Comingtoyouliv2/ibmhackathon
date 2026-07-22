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

test("failure signatures do not merge unrelated failures through a generic word", () => {
  assert.deepEqual(failureSignatures("1 failed"), []);
  assert.deepEqual(failureSignatures("FAIL test_a: expected true\n1 failed"), ["fail test_a: expected true"]);
  assert.deepEqual(failureSignatures("FAIL test_b: expected false\n1 failed"), ["fail test_b: expected false"]);
  assert.equal(classifyCombinedRuns({
    base: { status: "passed" }, a: { status: "passed" }, b: { status: "passed" },
    combined: { status: "failed", output: "FAIL test_a: expected true\n1 failed" },
    confirmation: { status: "failed", output: "FAIL test_b: expected false\n1 failed" },
  }).verdict, "insufficient");
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

test("cross-language contract provenance keeps the actual provider and consumer files", () => {
  const prepared = prepareIntegratedAnalysis([
    {
      id: "5277", number: 5277, title: "Add MCP Python client", baseSha: "base",
      files: [
        { filename: "pom.xml", status: "modified", patch: "@@ -1 +1 @@\n-old\n+<module>zeppelin-mcp</module>" },
        { filename: "zeppelin-mcp/.gitignore", status: "added", patch: "@@ -0,0 +1 @@\n+.venv" },
        { filename: "zeppelin-mcp/DESIGN.md", status: "added", patch: "@@ -0,0 +1 @@\n+restart a stuck interpreter" },
        { filename: "zeppelin-mcp/src/zeppelin_mcp/client.py", status: "added", patch: [
          "@@ -0,0 +1,2 @@",
          "+payload = {\"noteId\": note_id} if note_id else None",
          "+self._request(\"PUT\", f\"/interpreter/setting/restart/{setting_id}\", json=payload)",
        ].join("\n") },
      ],
    },
    {
      id: "5151", number: 5151, title: "Require noteId for restart", baseSha: "base",
      files: [{ filename: "zeppelin-server/src/main/java/org/apache/zeppelin/rest/InterpreterRestApi.java", status: "modified", patch: [
        "@@ -10,3 +10,4 @@",
        " @PUT",
        " @Path(\"setting/restart/{settingId}\")",
        "+if (noteId == null) throw new BadRequestException(\"noteId is required\");",
      ].join("\n") }],
    },
  ]);
  const comparison = prepared.comparisons[0];
  assert.ok(comparison.retrievalFeatures.sharedContracts.includes("api:http:PUT:/setting/restart/{param}"));
  assert.deepEqual(comparison.retrievalFeatures.contractFiles["api:http:PUT:/setting/restart/{param}"], {
    left: ["zeppelin-mcp/src/zeppelin_mcp/client.py"],
    right: ["zeppelin-server/src/main/java/org/apache/zeppelin/rest/InterpreterRestApi.java"],
  });
  const candidates = selectSemanticJudgeCandidates(prepared);
  const [caseInput] = buildSemanticJudgeCases(prepared, candidates);
  assert.ok(caseInput.prs[0].files.some((file) => file.filename.endsWith("client.py")));
  assert.ok(caseInput.prs[1].files.some((file) => file.filename.endsWith("InterpreterRestApi.java")));

  const [judgment] = normalizeSemanticJudgments(prepared, candidates, [{
    prIds: ["5277", "5151"], assessment: "contract-backed-conflict", category: "api",
    title: "MCP restart violates the new server contract", summary: "The old global restart call now returns HTTP 400.",
    assumptionOwner: "PR-A", assumption: "A restart without noteId remains a valid global restart.",
    violatingChange: "PR B rejects the same request when noteId is absent.", preconditions: ["note_id is None"],
    triggerSequence: ["MCP client sends PUT restart without a body", "server validates noteId"],
    expectedBehavior: "the interpreter restarts globally", possibleActualBehavior: "the server returns HTTP 400",
    contract: {
      identity: "PUT /setting/restart/{param}", kind: "http-api", providerSide: "PR-B", consumerSide: "PR-A",
      providerChange: "noteId becomes required", consumerDependency: "the client sends no noteId for global restart",
      composedFailure: "the client request is rejected with HTTP 400",
    },
    testPlan: { name: "restart without noteId", strategy: "targeted-test", setup: [], steps: ["call restart with note_id=None"], oracle: "HTTP status is not 400", targetTests: [] },
    confidence: 0.95,
    evidence: [
      { side: "A", file: "zeppelin-mcp/src/zeppelin_mcp/client.py", symbol: "restart_interpreter", quote: "self._request(\"PUT\", f\"/interpreter/setting/restart/{setting_id}\", json=payload)" },
      { side: "B", file: "zeppelin-server/src/main/java/org/apache/zeppelin/rest/InterpreterRestApi.java", symbol: "restartSetting", quote: "if (noteId == null) throw new BadRequestException(\"noteId is required\");" },
    ],
  }]);
  assert.equal(judgment.verdict, "conflict");
  assert.equal(judgment.evidenceGrade, "contract-backed");
  assert.equal(judgment.confirmationStatus, "contract-backed-static");
  assert.equal(judgment.runtimeVerification, "not-run");
});

test("AI proposes a testable hypothesis but never declares a conflict", () => {
  const prepared = prepareIntegratedAnalysis([
    pr("1", "src/Service.java", "@@ -1 +1 @@\n-old\n+newCall(oldArg);"),
    pr("2", "src/Service.java", "@@ -2 +2 @@\n-old\n+void newCall(NewArg arg) {}"),
  ]);
  const candidates = selectSemanticJudgeCandidates(prepared);
  const base = {
    prIds: ["1", "2"], assessment: "testable-hypothesis", assumptionOwner: "PR-A",
    assumption: "old argument remains accepted", violatingChange: "B only accepts NewArg",
    triggerSequence: ["build the combined tree"], expectedBehavior: "the call compiles",
    possibleActualBehavior: "the call does not compile",
    testPlan: { name: "compile old call", strategy: "targeted-test", setup: [], steps: ["compile the combined tree"], oracle: "compiler exits zero", targetTests: [] },
    evidence: [
      { side: "A", file: "src/Service.java", symbol: "newCall", quote: "newCall(oldArg);" },
      { side: "B", file: "src/Service.java", symbol: "newCall", quote: "void newCall(NewArg arg) {}" },
    ],
  };
  const hypothesis = normalizeSemanticJudgments(prepared, candidates, [base])[0];
  assert.equal(hypothesis.verdict, "review");
  assert.equal(hypothesis.interactionHypothesis.status, "testable-hypothesis");
  const downgraded = normalizeSemanticJudgments(prepared, candidates, [{ ...base, evidence: base.evidence.slice(0, 1) }])[0];
  assert.equal(downgraded.interactionHypothesis.status, "insufficient-evidence");
  assert.equal(downgraded.evidenceGate, "downgraded-incomplete-causal-evidence");
});

test("Anthropic adapter repairs control characters and uses the shared evidence gate", async () => {
  assert.deepEqual(extractJsonObject('prefix {"quote":"a\tb"} suffix'), { quote: "a\tb" });
  const prepared = prepareIntegratedAnalysis([
    pr("1", "src/Service.java", "@@ -1 +1 @@\n-old\n+newCall(oldArg);"),
    pr("2", "src/Service.java", "@@ -2 +2 @@\n-old\n+void newCall(NewArg arg) {}"),
  ]);
  let anthropicCalls = 0;
  const client = { messages: { create: async () => {
    anthropicCalls += 1;
    return ({ content: [{ type: "text", text: JSON.stringify({
    prIds: ["1", "2"], assessment: "testable-hypothesis", assumptionOwner: "PR-A",
    assumption: "old argument remains accepted", violatingChange: "B only accepts NewArg",
    triggerSequence: ["compile combined"], expectedBehavior: "compile succeeds", possibleActualBehavior: "compile fails",
    testPlan: { name: "compile", strategy: "targeted-test", setup: [], steps: ["compile combined"], oracle: "exit zero", targetTests: [] },
    evidence: [
      { side: "A", file: "src/Service.java", symbol: "newCall", quote: "newCall(oldArg);" },
      { side: "B", file: "src/Service.java", symbol: "newCall", quote: "void newCall(NewArg arg) {}" },
    ],
    }) }] });
  } } };
  const judgments = await analyzeWithAnthropic(prepared, { client, concurrency: 1 });
  assert.equal(anthropicCalls, 3);
  assert.equal(judgments[0].verdict, "review");
  assert.equal(judgments[0].interactionHypothesis.status, "testable-hypothesis");
  assert.equal(judgments[0].source, "anthropic");
  assert.equal(judgments[0].aiProtocol.stable, true);
  assert.equal(judgments[0].aiProtocol.requestedRepeats, 3);
});

test("Codex adapter uses the same second-look and bilateral evidence contract", async () => {
  const prepared = prepareIntegratedAnalysis([
    pr("1", "src/Service.java", "@@ -1 +1 @@\n-old\n+newCall(oldArg);"),
    pr("2", "src/Service.java", "@@ -2 +2 @@\n-old\n+void newCall(NewArg arg) {}"),
  ]);
  let codexCalls = 0;
  const runner = async (caseInput) => {
    codexCalls += 1;
    return ({
    prIds: caseInput.prIds,
    assessment: "testable-hypothesis",
    category: "api",
    title: "signature mismatch",
    summary: "A uses the old contract while B replaces it.",
    assumptionOwner: "PR-A",
    assumption: "old argument remains accepted",
    violatingChange: "only NewArg is accepted",
    preconditions: [],
    triggerSequence: ["compile combined"],
    expectedBehavior: "compile succeeds",
    possibleActualBehavior: "the combined call no longer compiles",
    testPlan: { name: "compile", strategy: "targeted-test", setup: [], steps: ["compile combined"], oracle: "exit zero", targetTests: [] },
    confidence: 0.9,
    evidence: [
      { side: "A", file: "src/Service.java", symbol: "newCall", quote: "newCall(oldArg);" },
      { side: "B", file: "src/Service.java", symbol: "newCall", quote: "void newCall(NewArg arg) {}" },
    ],
    });
  };
  const judgments = await analyzeWithCodex(prepared, { runner, concurrency: 1 });
  assert.equal(codexCalls, 3);
  assert.equal(judgments[0].verdict, "review");
  assert.equal(judgments[0].interactionHypothesis.testPlan.name, "compile");
  assert.equal(judgments[0].source, "codex");
  assert.equal(judgments[0].aiStability, "stable");
});

test("AI protocol routes disagreement or missing repeats to needs-review", async () => {
  const prepared = prepareIntegratedAnalysis([
    pr("1", "src/Service.java", "@@ -1 +1 @@\n-old\n+newCall(oldArg);"),
    pr("2", "src/Service.java", "@@ -2 +2 @@\n-old\n+void newCall(NewArg arg) {}"),
  ]);
  let calls = 0;
  const runner = async (caseInput) => {
    calls += 1;
    if (calls === 2) return {
      prIds: caseInput.prIds,
      assessment: "no-plausible-interaction",
      category: "code",
      title: "no interaction",
      summary: "No behavior path connects the changes.",
      assumptionOwner: "unknown",
      assumption: "",
      violatingChange: "",
      preconditions: [], triggerSequence: [], expectedBehavior: "", possibleActualBehavior: "",
      contract: { identity: "", kind: "", providerSide: "unknown", consumerSide: "unknown", providerChange: "", consumerDependency: "", composedFailure: "" },
      testPlan: { name: "", strategy: "targeted-test", setup: [], steps: [], oracle: "", targetTests: [] },
      confidence: 0.6, evidence: [],
    };
    if (calls === 3) throw new Error("transient model failure");
    return {
      prIds: caseInput.prIds,
      assessment: "testable-hypothesis",
      category: "api",
      title: "signature mismatch",
      summary: "A uses the old contract while B replaces it.",
      assumptionOwner: "PR-A",
      assumption: "old argument remains accepted",
      violatingChange: "only NewArg is accepted",
      preconditions: [], triggerSequence: ["compile combined"],
      expectedBehavior: "compile succeeds", possibleActualBehavior: "compile fails",
      contract: { identity: "", kind: "", providerSide: "unknown", consumerSide: "unknown", providerChange: "", consumerDependency: "", composedFailure: "" },
      testPlan: { name: "compile", strategy: "targeted-test", setup: [], steps: ["compile combined"], oracle: "exit zero", targetTests: [] },
      confidence: 0.8,
      evidence: [
        { side: "A", file: "src/Service.java", symbol: "newCall", quote: "newCall(oldArg);" },
        { side: "B", file: "src/Service.java", symbol: "newCall", quote: "void newCall(NewArg arg) {}" },
      ],
    };
  };
  const [judgment] = await analyzeWithCodex(prepared, {
    runner, concurrency: 1, primaryLimit: 1, secondLookLimit: 1, aiRepeats: 3,
  });
  assert.equal(calls, 3);
  assert.equal(judgment.verdict, "review");
  assert.equal(judgment.aiStability, "unstable");
  assert.equal(judgment.aiProtocol.completedRepeats, 2);
  assert.deepEqual(judgment.aiProtocol.assessments, ["testable-hypothesis", "no-plausible-interaction", "missing"]);
  assert.equal(judgment.aiProtocol.finalTriage, "needs-review");
});
