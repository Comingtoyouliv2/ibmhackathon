import {
  buildSemanticJudgeCases,
  normalizeSemanticJudgments,
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
              setup: { type: "array", items: { type: "string" } }, steps: { type: "array", items: { type: "string" } },
              oracle: { type: "string" }, targetTests: { type: "array", items: { type: "string" } },
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
  throw new Error("OpenAI 응답에 비교 결과가 없습니다.");
}

export async function analyzeWithAI(prepared, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return [];
  const model = options.model || process.env.OPENAI_MODEL || "gpt-5.6-terra";
  const candidates = selectSemanticJudgeCandidates(prepared, options);
  if (!candidates.length) return [];
  const cases = buildSemanticJudgeCases(prepared, candidates, options);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, store: false, reasoning: { effort: "medium" },
      input: [
        { role: "system", content: SEMANTIC_JUDGE_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({
          instruction: "각 case를 독립적으로 판정하라. 양쪽 실제 코드가 provider 변경→consumer 의존→합성 실패를 완결하면 contract-backed-conflict를 선택하되 executable-confirmed로 표현하지 마라. contract-backed-conflict 또는 testable-hypothesis이면 양쪽 실제 quote와 실행 가능한 트리거·oracle을 반환하라.",
          cases,
        }) },
      ],
      text: { format: { type: "json_schema", name: "pr_semantic_comparisons", strict: true, schema } },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const payload = JSON.parse(extractOutput(await response));
  return normalizeSemanticJudgments(prepared, candidates, payload.comparisons, {
    source: "openai", basis: "openai-interaction-hypothesis-v0.3",
  });
}
