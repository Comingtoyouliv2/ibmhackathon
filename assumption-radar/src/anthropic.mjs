import {
  aggregateSemanticJudgmentRuns,
  buildSemanticJudgeCases,
  runRepeatedCaseJudgments,
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
    "양쪽 실제 코드가 provider 변경 → consumer 의존 → 합성 실패로 완결되면 contract-backed-conflict를 선택할 수 있다. 이는 실행 확정이 아니라 코드 계약 증거 등급이다.",
    "contract-backed-conflict 또는 testable-hypothesis는 A와 B 양쪽의 실제 quote를 하나 이상씩 제시하고 트리거 순서와 oracle이 있을 때만 선택한다.",
    "다음 JSON object 하나만 반환하라:",
    '{"prIds":["...","..."],"assessment":"contract-backed-conflict|testable-hypothesis|no-plausible-interaction|insufficient-evidence|coordination-required","category":"api|data|config|auth|event|rollout|behavior|code","title":"...","summary":"...","assumptionOwner":"PR-A|PR-B|both|unknown","assumption":"...","violatingChange":"...","preconditions":["..."],"triggerSequence":["..."],"expectedBehavior":"...","possibleActualBehavior":"...","contract":{"identity":"...","kind":"...","providerSide":"PR-A|PR-B|unknown","consumerSide":"PR-A|PR-B|unknown","providerChange":"...","consumerDependency":"...","composedFailure":"..."},"testPlan":{"name":"...","strategy":"existing-test|targeted-test|property-test|fuzz|trace-differential","setup":["..."],"steps":["..."],"oracle":"...","targetTests":["..."]},"confidence":0.0,"evidence":[{"side":"A|B","file":"...","symbol":"...","quote":"verbatim input quote"}]}',
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
  const protocolRuns = await runRepeatedCaseJudgments(cases, async (caseInput) => {
    const message = await client.messages.create({
        model,
        max_tokens: Number(options.maxTokens || 4_000),
        thinking: { type: "adaptive" },
        output_config: { effort: options.effort || "high" },
        system: SEMANTIC_JUDGE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: judgmentPrompt(caseInput) }],
    });
    const text = (message.content || []).filter((block) => block.type === "text").map((block) => block.text).join("");
    return extractJsonObject(text);
  }, options);
  if (!protocolRuns.runs.some((run) => run.some((raw) => raw && !raw.protocolError))) {
    throw new Error("모든 Anthropic 반복 판정이 실패했습니다.");
  }
  return aggregateSemanticJudgmentRuns(prepared, candidates, protocolRuns, {
    ...options,
    source: "anthropic", basis: "anthropic-interaction-hypothesis-v0.5",
  });
}
