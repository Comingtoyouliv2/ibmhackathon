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
  if (start < 0 || end < start) throw new Error("The Anthropic response contains no JSON object.");
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
    "The input contains exactly one PR pair. Do not infer another pair or classify generic risk as conflict.",
    "Choose contract-backed-conflict when real code on both sides completes a provider-change to consumer-dependency to composed-failure path. This is a code-contract evidence grade, not executable confirmation.",
    "Choose contract-backed-conflict or testable-hypothesis only when you provide at least one real quote from both A and B plus a trigger sequence and oracle.",
    "Return exactly one JSON object and write all explanations in English:",
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
    throw new Error("All repeated Anthropic judgments failed.");
  }
  return aggregateSemanticJudgmentRuns(prepared, candidates, protocolRuns, {
    ...options,
    source: "anthropic", basis: "anthropic-interaction-hypothesis-v0.5",
  });
}
