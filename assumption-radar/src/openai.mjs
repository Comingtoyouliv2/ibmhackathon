import {
  aggregateSemanticJudgmentRuns,
  buildSemanticJudgeCases,
  semanticJudgeRepeatCount,
  selectSemanticJudgeCandidates,
  SEMANTIC_JUDGE_SYSTEM_PROMPT,
} from "./semantic-judge.mjs";

const schema = {
  type: "object", additionalProperties: false,
  properties: {
    comparisons: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          prIds: { type: "array", items: { type: "string" } },
          assessment: { type: "string", enum: ["contract-backed-conflict", "testable-hypothesis", "no-plausible-interaction", "insufficient-evidence", "coordination-required"] },
          category: { type: "string", enum: ["api", "data", "config", "auth", "event", "rollout", "behavior", "code"] },
          title: { type: "string" }, summary: { type: "string" },
          assumptionOwner: { type: "string", enum: ["PR-A", "PR-B", "both", "unknown"] },
          assumption: { type: "string" }, violatingChange: { type: "string" },
          preconditions: { type: "array", items: { type: "string" } },
          triggerSequence: { type: "array", items: { type: "string" } },
          expectedBehavior: { type: "string" }, possibleActualBehavior: { type: "string" },
          contract: {
            type: "object", additionalProperties: false,
            properties: {
              identity: { type: "string" }, kind: { type: "string" },
              providerSide: { type: "string", enum: ["PR-A", "PR-B", "unknown"] },
              consumerSide: { type: "string", enum: ["PR-A", "PR-B", "unknown"] },
              providerChange: { type: "string" }, consumerDependency: { type: "string" }, composedFailure: { type: "string" },
            },
            required: ["identity", "kind", "providerSide", "consumerSide", "providerChange", "consumerDependency", "composedFailure"],
          },
          testPlan: {
            type: "object", additionalProperties: false,
            properties: {
              name: { type: "string" },
              strategy: { type: "string", enum: ["existing-test", "targeted-test", "property-test", "fuzz", "trace-differential"] },
              setup: { type: "array", items: { type: "string" } },
              steps: { type: "array", items: { type: "string" } },
              oracle: { type: "string" },
              targetTests: { type: "array", items: { type: "string" } },
            },
            required: ["name", "strategy", "setup", "steps", "oracle", "targetTests"],
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              properties: {
                side: { type: "string", enum: ["A", "B"] },
                file: { type: "string" }, symbol: { type: "string" }, quote: { type: "string" },
              },
              required: ["side", "file", "symbol", "quote"],
            },
          },
        },
        required: ["prIds", "assessment", "category", "title", "summary", "assumptionOwner", "assumption", "violatingChange", "preconditions", "triggerSequence", "expectedBehavior", "possibleActualBehavior", "contract", "testPlan", "confidence", "evidence"],
      },
    },
  },
  required: ["comparisons"],
};

function extractOutput(response) {
  if (response.output_text) return response.output_text;
  for (const item of response.output || []) for (const content of item.content || []) if (content.type === "output_text" && content.text) return content.text;
  throw new Error("The OpenAI response contains no comparison result.");
}

export async function analyzeWithAI(prepared, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return [];
  const model = options.model || process.env.OPENAI_MODEL || "gpt-5.6-terra";
  const reasoningEffort = options.reasoningEffort || process.env.OPENAI_REASONING_EFFORT || "medium";
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(reasoningEffort)) {
    throw new Error(`Unsupported OpenAI reasoning effort: ${reasoningEffort}`);
  }
  const candidates = selectSemanticJudgeCandidates(prepared, options);
  if (!candidates.length) return [];
  const cases = buildSemanticJudgeCases(prepared, candidates, options);
  const repeats = semanticJudgeRepeatCount(options);
  const runs = [];
  const errors = [];
  for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model, store: false, reasoning: { effort: reasoningEffort },
          input: [
            { role: "system", content: SEMANTIC_JUDGE_SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify({
              instruction: "Judge every case independently. Choose contract-backed-conflict when real code on both sides completes a provider-change to consumer-dependency to composed-failure path, but do not call it executable-confirmed. For contract-backed-conflict or testable-hypothesis, return verbatim quotes from both sides plus an executable trigger and oracle. Return all explanations in English.",
              cases,
            }) },
          ],
          text: { format: { type: "json_schema", name: "pr_semantic_comparisons", strict: true, schema } },
        }),
      });
      if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const payload = JSON.parse(extractOutput(await response));
      runs.push(payload.comparisons || []);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      runs.push(cases.map((item) => ({ prIds: item.prIds, protocolError: errors.at(-1) })));
    }
  }
  if (errors.length === repeats) throw new Error(`All repeated OpenAI judgments failed: ${errors[0]}`);
  return aggregateSemanticJudgmentRuns(prepared, candidates, { repeats, runs }, {
    ...options,
    source: "openai", basis: "openai-interaction-hypothesis-v0.5",
  });
}
