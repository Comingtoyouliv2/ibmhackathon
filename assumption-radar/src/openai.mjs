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
          verdict: { type: "string", enum: ["conflict", "compatible", "uncertain", "coordination"] },
          category: { type: "string", enum: ["api", "data", "config", "auth", "event", "rollout", "behavior", "code"] },
          title: { type: "string" }, summary: { type: "string" },
          assumptionA: { type: "string" }, assumptionB: { type: "string" },
          consequence: { type: "string" }, recommendation: { type: "string" },
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
        required: ["prIds", "verdict", "category", "title", "summary", "assumptionA", "assumptionB", "consequence", "recommendation", "evidence"],
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
          instruction: "각 case를 독립적으로 판정하라. conflict이면 A와 B 양쪽에서 실제 입력에 존재하는 quote를 최소 하나씩 반환하라.",
          cases,
        }) },
      ],
      text: { format: { type: "json_schema", name: "pr_semantic_comparisons", strict: true, schema } },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const payload = JSON.parse(extractOutput(await response));
  return normalizeSemanticJudgments(prepared, candidates, payload.comparisons, {
    source: "openai", basis: "openai-semantic-judgment-v0.2",
  });
}
