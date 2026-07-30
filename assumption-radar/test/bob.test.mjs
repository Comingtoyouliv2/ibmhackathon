import assert from "node:assert/strict";
import test from "node:test";
import { semanticJudgeProvider } from "../src/ai.mjs";
import { parseBobOutput, runRemoteBobJudgment } from "../src/bob.mjs";

test("IBM Bob is an explicit semantic judge provider", () => {
  assert.equal(semanticJudgeProvider({ aiProvider: "bob" }), "bob");
});

test("Bob output parser selects the final PR-pair JSON object from CLI text", () => {
  const result = parseBobOutput([
    "IBM Bob progress {not json}",
    '{"example":{"prIds":["old-a","old-b"]}}',
    "```json",
    '{"prIds":["a","b"],"assessment":"no-plausible-interaction","summary":"No path connects the changes."}',
    "```",
  ].join("\n"));
  assert.deepEqual(result.prIds, ["a", "b"]);
  assert.equal(result.assessment, "no-plausible-interaction");
});

test("Bob output parser accepts a comparisons wrapper", () => {
  const result = parseBobOutput(JSON.stringify({
    comparisons: [{ prIds: ["a", "b"], assessment: "insufficient-evidence" }],
  }));
  assert.equal(result.assessment, "insufficient-evidence");
});

test("remote Bob runner sends the prompt and API key over an authenticated request", async () => {
  let request;
  const judgment = await runRemoteBobJudgment({
    prompt: "judge this pair",
    apiKey: "bob-test-key",
    runnerUrl: "https://runner.example/api/bob-judge",
    runnerToken: "gateway-secret",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({
        judgment: { prIds: ["a", "b"], assessment: "insufficient-evidence" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(request.url, "https://runner.example/api/bob-judge");
  assert.equal(request.options.headers.Authorization, "Bearer gateway-secret");
  assert.deepEqual(JSON.parse(request.options.body), {
    prompt: "judge this pair",
    apiKey: "bob-test-key",
  });
  assert.equal(judgment.assessment, "insufficient-evidence");
});

test("remote Bob runner rejects insecure non-local URLs", async () => {
  await assert.rejects(() => runRemoteBobJudgment({
    prompt: "judge",
    apiKey: "key",
    runnerUrl: "http://runner.example/api/bob-judge",
    fetchImpl: async () => new Response("{}"),
  }), /must use HTTPS/);
});
