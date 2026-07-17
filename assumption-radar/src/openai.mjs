import crypto from "node:crypto";

const SYSTEM_PROMPT = `당신은 여러 pull request 사이의 의미적 상호작용을 판정하는 수석 소프트웨어 아키텍트다.
점수나 저장소 공통 임계값을 사용하지 않는다. 제공된 witness와 관련 diff를 바탕으로 논리적 판정을 내린다.
verdict 규칙:
- conflict: 두 변경이 동시에 참일 수 없거나 한쪽이 요구하는 계약을 다른 쪽이 제거한다.
- compatible: 같은 영역을 만지지만 의도가 정렬되어 함께 적용 가능하다.
- uncertain: 상호작용은 있으나 base 코드, 호출 관계, 테스트 없이는 확정할 수 없다.
같은 파일이라는 사실만으로 conflict를 만들지 않는다. A와 B의 전제를 대칭적으로 쓰고, 반드시 구체적인 diff 근거를 제시한다.
결과는 한국어로 간결하게 작성한다.`;

const schema = {
  type: "object", additionalProperties: false,
  properties: {
    comparisons: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          prIds: { type: "array", items: { type: "string" } },
          verdict: { type: "string", enum: ["conflict", "compatible", "uncertain"] },
          category: { type: "string", enum: ["api", "data", "config", "auth", "event", "rollout", "behavior", "code"] },
          title: { type: "string" }, summary: { type: "string" },
          assumptionA: { type: "string" }, assumptionB: { type: "string" },
          consequence: { type: "string" }, recommendation: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
        },
        required: ["prIds", "verdict", "category", "title", "summary", "assumptionA", "assumptionB", "consequence", "recommendation", "evidence"],
      },
    },
  },
  required: ["comparisons"],
};

function compactPr(pr, relevantPaths) {
  return {
    id: pr.id, number: pr.number, title: pr.title, body: pr.body.slice(0, 1800), assumptions: pr.assumptions,
    files: pr.files.filter((file) => relevantPaths.has(file.filename)).slice(0, 30).map((file) => ({
      filename: file.filename, status: file.status, patch: (file.patch || "").slice(0, 9000),
    })),
  };
}

function extractOutput(response) {
  if (response.output_text) return response.output_text;
  for (const item of response.output || []) for (const content of item.content || []) if (content.type === "output_text" && content.text) return content.text;
  throw new Error("OpenAI 응답에 비교 결과가 없습니다.");
}

export async function analyzeWithAI(prepared, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return [];
  const model = options.model || process.env.OPENAI_MODEL || "gpt-5.6-terra";
  const candidates = prepared.candidates.filter((item) => item.verdict === "review").slice(0, 20);
  if (!candidates.length) return [];
  const candidateIds = new Set(candidates.flatMap((item) => item.prIds));
  const relevantPaths = new Set(candidates.flatMap((item) => item.witnesses.flatMap((witness) => witness.evidence.filter((value) => value.includes("/") || value.includes(".")))));
  const prs = prepared.prs.filter((pr) => candidateIds.has(pr.id)).map((pr) => compactPr(pr, relevantPaths));
  const input = candidates.map((item) => ({
    prIds: item.prIds, deterministicVerdict: item.verdict,
    witnesses: item.witnesses.map(({ type, strength, category, explanation, evidence }) => ({ type, strength, category, explanation, evidence })),
  }));
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, store: false, reasoning: { effort: "medium" },
      input: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: JSON.stringify({ prs, comparisons: input }) }],
      text: { format: { type: "json_schema", name: "pr_semantic_comparisons", strict: true, schema } },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const payload = JSON.parse(extractOutput(await response));
  const validPairs = new Set(candidates.map((item) => [...item.prIds].sort().join(":")));
  return payload.comparisons
    .filter((item) => item.prIds.length === 2 && validPairs.has([...item.prIds].sort().join(":")))
    .map((item) => ({
      ...item, id: crypto.randomUUID(),
      verdict: item.verdict === "compatible" ? "independent" : item.verdict === "uncertain" ? "review" : "conflict",
      evidence: item.evidence.slice(0, 8), basis: "ai-semantic-judgment", source: "ai",
    }));
}
