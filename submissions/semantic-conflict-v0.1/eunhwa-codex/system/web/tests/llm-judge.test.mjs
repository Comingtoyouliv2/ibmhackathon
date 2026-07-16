import test from "node:test";
import assert from "node:assert/strict";
import { generateLlmCandidates, judgePairWithLlm, normalizeJudgment } from "../app/lib/llm-judge.ts";

const contextA = { pr: 1, title: "worker A owns queue cleanup", body: "A deletes the queue after every run.", files: [{ path: "queue.ts", patch: "+deleteQueue();" }], facts: [] };
const contextB = { pr: 2, title: "worker B owns queue cleanup", body: "B keeps the queue for retry.", files: [{ path: "queue.ts", patch: "+retainQueueForRetry();" }], facts: [] };

test("LLM candidates include unresolved medium/weak pairs and exclude known text conflicts", () => {
  const candidates = generateLlmCandidates({
    cards: [
      { pr: 1, title: "a", files: ["a.ts", "b.ts"], touchedResources: [], assumptions: [], facts: [] },
      { pr: 2, title: "b", files: ["a.ts"], touchedResources: [], assumptions: [], facts: [] },
      { pr: 3, title: "c", files: ["b.ts"], touchedResources: [], assumptions: [], facts: [] },
    ],
    candidates: [],
    semanticCandidates: [
      { a: 1, b: 2, sharedResources: ["literal:session"], candidateTier: "medium", candidateScore: 5, candidateSources: ["lexical"] },
      { a: 1, b: 3, sharedResources: ["literal:cleanup"], candidateTier: "weak", candidateScore: 2, candidateSources: ["lexical"] },
    ],
    pairTextConflicts: [{ a: 1, b: 2, sharedResources: ["file:a.ts"], verdict: "text_conflict", rationale: "conflict", evidence: [], verifiedAt: "now" }],
  });
  assert.deepEqual(candidates.map((pair) => [pair.a, pair.b, pair.sharedResources]), [[1, 3, ["literal:cleanup"]]]);
});

test("LLM selection skips strong exact contracts but includes unresolved patch interactions", () => {
  const candidates = generateLlmCandidates({
    cards: [],
    candidates: [],
    semanticCandidates: [
      { a: 1, b: 2, sharedResources: ["api:src/a#save"], candidateTier: "strong", candidateSources: ["contract"] },
    ],
    needsVerification: [{
      a: 3, b: 4, sharedResources: ["file:src/state.ts"], candidateTier: "strong", candidateSources: ["lexical"],
      verdict: "needs_verification", reasonCode: "patch_interaction", rationale: "same state", evidence: [],
    }],
  });
  assert.deepEqual(candidates.map((pair) => [pair.a, pair.b]), [[3, 4]]);
});

test("CI baseline metadata does not remove an unresolved patch interaction from LLM review", () => {
  const candidates = generateLlmCandidates({
    cards: [], candidates: [], semanticCandidates: [],
    needsVerification: [{
      a: 5, b: 6, sharedResources: ["file:src/cache.ts"], candidateTier: "strong",
      verdict: "needs_verification", reasonCode: "patch_interaction",
      rationale: "CI baseline unverified; same cache state is written", evidence: [],
    }],
  });
  assert.deepEqual(candidates.map((pair) => [pair.a, pair.b]), [[5, 6]]);
});

test("unsupported LLM quotes downgrade a conflict to uncertain", () => {
  const result = normalizeJudgment({
    verdict: "conflict",
    family: "ownership",
    claim: "incompatible owners",
    evidence: [{ pr: "A", file: "queue.ts", quote: "invented quote" }, { pr: "B", file: "queue.ts", quote: "another invented quote" }],
    counterevidence: [],
    verification: ["run retry test"],
  }, contextA, contextB);
  assert.equal(result.verdict, "uncertain");
  assert.equal(result.evidence.length, 0);
  assert.ok(result.validationErrors.length >= 2);
});

test("a conflict requires supported evidence from both PR orders", async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    const request = JSON.parse(init.body);
    const input = JSON.parse(request.input);
    const judgment = {
      verdict: "conflict",
      family: "lifecycle",
      claim: "one PR deletes retry state while the other retains it",
      evidence: [
        { pr: "A", file: "queue.ts", quote: input.prA.body },
        { pr: "B", file: "queue.ts", quote: input.prB.body },
      ],
      counterevidence: [],
      verification: ["merge both PRs and run queue retry after cleanup"],
    };
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(judgment) }] }] }), { status: 200 });
  };
  const result = await judgePairWithLlm(
    { a: 1, b: 2, sharedResources: ["file:queue.ts"] },
    contextA,
    contextB,
    { apiKey: "test", model: "test-model", fetchImpl },
  );
  assert.equal(calls, 2);
  assert.equal(result.finding?.verdict, "llm_conflict");
  assert.equal(result.finding?.confirmationCount, 2);
  assert.deepEqual(new Set(result.finding?.evidence.map((item) => item.pr)), new Set([1, 2]));
});

test("Gemini provider uses structured JSON and normalizes the result", async () => {
  process.env.GEMINI_MIN_INTERVAL_MS = "0";
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    const judgment = {
      verdict: "no_conflict",
      family: "none",
      claim: "the lifecycle policies can coexist",
      evidence: [],
      counterevidence: [],
      verification: ["run the queue retry test"],
    };
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(judgment) }] }, finishReason: "STOP" }],
    }), { status: 200 });
  };
  try {
    const result = await judgePairWithLlm(
      { a: 1, b: 2, sharedResources: ["file:queue.ts"] },
      contextA,
      contextB,
      { apiKey: "test", provider: "gemini", model: "gemini-test", fetchImpl },
    );
    assert.equal(result.noConflict, true);
    assert.match(request.url, /gemini-test:generateContent$/);
    assert.equal(request.init.headers["x-goog-api-key"], "test");
    assert.equal(request.body.generationConfig.responseMimeType, "application/json");
    assert.equal(request.body.generationConfig.responseJsonSchema.properties.verdict.type, "string");
  } finally {
    delete process.env.GEMINI_MIN_INTERVAL_MS;
  }
});
