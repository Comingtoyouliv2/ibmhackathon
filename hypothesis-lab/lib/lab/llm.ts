/** Server-side LLM calls: question → spec (Claude), stats → dual verification. */

import { LAB_COINS } from "./coins";
import type { LabExecution, LabSpec } from "./shared";
import type { AiOpinion } from "@/lib/hypothesis/types";

const CLAUDE_MODEL = "claude-sonnet-4-5";
const OPENAI_MODEL = "gpt-4o";

function extractJson<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

async function callClaude(prompt: string, maxTokens = 700): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`claude ${res.status}`);
  const out = await res.json();
  return out.content[0].text as string;
}

async function callOpenAi(prompt: string, maxTokens = 700): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const out = await res.json();
  return out.choices[0].message.content as string;
}

// ------------------------------------------------------------------- parsing

const PARSE_PROMPT = `You convert a retail trader's natural-language market hypothesis (Korean or English) into a strict JSON analysis spec. The spec is executed by a deterministic pandas engine over a daily Hyperliquid dataset (2023-05 ~ 2026-06) with columns: mark price close, funding rate, open interest.

Available coins (uppercase symbols): __COINS__

Spec schema:
{
  "coin": "<symbol, default BTC>",
  "conditions": [
    {"type":"fomc","action":"cut"|"hike"|"hold"|"any"}                      // FOMC rate decision days
    {"type":"daily_return","op":"lte"|"gte","valuePct":<number>}            // day's return threshold, e.g. crash = lte -5
    {"type":"streak","direction":"up"|"down","days":<1-10>}                 // N consecutive up/down days
    {"type":"funding","op":"lte"|"gte","value":<raw rate, 0 = neutral>}     // funding rate threshold (negative = shorts pay)
    {"type":"funding_percentile","side":"bottom"|"top","pct":<1-50>}        // extreme funding days
    {"type":"oi_change","op":"gte"|"lte","valuePct":<number>}               // 1-day open interest change %
    {"type":"weekday","days":[0-6]}                                         // 0=Mon .. 6=Sun
    {"type":"month","months":[1-12]}
  ],
  "target": {"horizonDays": <1-30>, "direction": "up"|"down"},
  "interpretation": "<one short Korean sentence restating exactly what will be measured>"
}

Rules:
- Multiple conditions are ANDed.
- "direction" is what the USER's hypothesis predicts (e.g. "반등할까?" → up, "떨어질까?" → down). Default horizonDays 1.
- Map coin names to symbols (비트코인→BTC, 이더/이더리움→ETH, 솔라나→SOL, 도지→DOGE ...). If the coin is not in the list, still output your best symbol guess — the engine will suggest alternatives.
- The dataset has NO: intraday data, volume, CPI/NFP/election calendars, news, on-chain metrics, stocks. If the question needs those or cannot map to the schema, output {"unsupported": true, "reason": "<short Korean explanation of what IS possible instead>"}.
- Questions about volatility, correlations, or price targets are unsupported in v1.
- Output ONLY the JSON object, no markdown.

Question: __QUESTION__`;

export async function parseQuestion(question: string): Promise<LabSpec> {
  const prompt = PARSE_PROMPT.replace("__COINS__", LAB_COINS.join(",")).replace(
    "__QUESTION__",
    question,
  );
  const text = await callClaude(prompt, 500);
  return extractJson<LabSpec>(text);
}

// -------------------------------------------------------------- verification

const VERIFY_PROMPT = `You are auditing a crypto hypothesis backtest for a public trading site. All numbers below were mechanically computed by pandas from 3 years of Hyperliquid daily data. Do NOT invent numbers; judge only from these stats. Be honest about small samples and weak edges.

User's hypothesis: __QUESTION__
How it was tested: __INTERPRETATION__
Computed stats: __STATS__
Sample cases: __CASES__

Verdict rules: p<0.05 supported, p<0.10 weak, n<5 inconclusive, else rejected.
Respond with ONLY valid JSON:
{"verdict":"supported"|"weak"|"rejected"|"inconclusive","confidence":"high"|"medium"|"low","commentary_ko":"<2-3 sentences in Korean. State the probability plainly (e.g. 'N번 중 K번, 확률 X%로 기저 Y%와 비슷'), mention sample-size or regime caveats, plain language>"}`;

function verifyPrompt(question: string, spec: LabSpec, result: LabExecution): string {
  return VERIFY_PROMPT.replace("__QUESTION__", question)
    .replace("__INTERPRETATION__", spec.interpretation ?? JSON.stringify(spec))
    .replace("__STATS__", JSON.stringify({ ...result.stats, ...result.meta }))
    .replace("__CASES__", JSON.stringify(result.cases.slice(-20)));
}

export async function dualVerify(
  question: string,
  spec: LabSpec,
  result: LabExecution,
): Promise<{ claude: AiOpinion | null; openai: AiOpinion | null }> {
  const prompt = verifyPrompt(question, spec, result);
  const [claude, openai] = await Promise.all([
    callClaude(prompt)
      .then((t) => ({ ...extractJson<Omit<AiOpinion, "model">>(t), model: CLAUDE_MODEL }))
      .catch(() => null),
    callOpenAi(prompt)
      .then((t) => ({ ...extractJson<Omit<AiOpinion, "model">>(t), model: OPENAI_MODEL }))
      .catch(() => null),
  ]);
  return { claude, openai };
}
