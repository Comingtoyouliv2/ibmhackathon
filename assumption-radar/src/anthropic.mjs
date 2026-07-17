import {
  buildSemanticJudgeCases,
  normalizeSemanticJudgments,
  selectSemanticJudgeCandidates,
  SEMANTIC_JUDGE_SYSTEM_PROMPT,
} from "./semantic-judge.mjs";

export function repairJsonControlChars(raw) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (const character of raw) {
    if (escaped) { output += character; escaped = false; continue; }
    if (character === "\\") { output += character; escaped = true; continue; }
    if (character === '"') { inString = !inString; output += character; continue; }
    if (inString && character.charCodeAt(0) < 0x20) {
      if (character === "\t") output += "\\t";
      else if (character === "\n") output += "\\n";
      else if (character === "\r") output += "\\r";
      else output += `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }
    output += character;
  }
  return output;
}

export function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Anthropic 응답에 JSON object가 없습니다.");
  const body = text.slice(start, end + 1);
  try { return JSON.parse(body); }
  catch { return JSON.parse(repairJsonControlChars(body)); }
}

async function defaultClient(apiKey, options) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey, timeout: options.timeoutMs || 20 * 60 * 1_000, maxRetries: options.maxRetries ?? 2 });
}

function judgmentPrompt(caseInput) {
  return [
    "아래에는 단 하나의 PR pair만 있다. 다른 pair를 추론하거나 일반적인 위험을 conflict로 판정하지 마라.",
    "conflict는 A와 B 양쪽의 실제 quote를 하나 이상씩 제시하고 구체적인 pair-induced failure를 설명할 때만 선택한다.",
    "다음 JSON object 하나만 반환하라:",
    '{"prIds":["...","..."],"verdict":"conflict|compatible|uncertain|coordination","category":"api|data|config|auth|event|rollout|behavior|code","title":"...","summary":"...","assumptionA":"...","assumptionB":"...","failureMechanism":"...","recommendation":"...","confidence":0.0,"evidence":[{"side":"A|B","file":"...","symbol":"...","quote":"verbatim input quote"}]}',
    "CASE_JSON:",
    JSON.stringify(caseInput),
  ].join("\n");
}

export async function analyzeWithAnthropic(prepared, options = {}) {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey && !options.client) return [];
  const candidates = selectSemanticJudgeCandidates(prepared, options);
  if (!candidates.length) return [];
  const cases = buildSemanticJudgeCases(prepared, candidates, options);
  const client = options.client || await defaultClient(apiKey, options);
  const model = options.model || process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency || 4)));
  const rawJudgments = [];
  let cursor = 0;

  async function worker() {
    while (cursor < cases.length) {
      const caseInput = cases[cursor++];
      const message = await client.messages.create({
        model,
        max_tokens: Number(options.maxTokens || 4_000),
        thinking: { type: "adaptive" },
        output_config: { effort: options.effort || "high" },
        system: SEMANTIC_JUDGE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: judgmentPrompt(caseInput) }],
      });
      const text = (message.content || []).filter((block) => block.type === "text").map((block) => block.text).join("");
      rawJudgments.push(extractJsonObject(text));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));
  return normalizeSemanticJudgments(prepared, candidates, rawJudgments, {
    source: "anthropic", basis: "anthropic-semantic-judgment-v0.2",
  });
}
