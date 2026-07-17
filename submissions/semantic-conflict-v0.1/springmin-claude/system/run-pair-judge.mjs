#!/usr/bin/env node
// Test 1 · Pair Judgment — 실제 LLM 러너
//
// 규칙 준수:
//  - SYSTEM_PROMPT.txt 를 변경 없이 system 으로 사용
//  - USER_PROMPT_TEMPLATE.txt 의 {{CASE_JSON}} 만 해당 입력 줄로 치환 (full record 주입)
//  - 입력 한 줄당 정확히 AI 호출 1회, 케이스 간 정보 유입 없음
//  - temperature: Opus 4.8 은 temperature/top_p/top_k 를 거부(400)하므로 전송하지 않는다.
//    모델이 지원하는 가장 결정적인 설정 = 샘플링 파라미터 없음 + output_config.effort 고정.
//  - latency/token 은 응답에서 실측해 기록 (추정 금지)
//
// 사용:
//   export ANTHROPIC_API_KEY=sk-ant-...
//   node work/run-pair-judge.mjs            # 40건 전체
//   node work/run-pair-judge.mjs --limit 2  # 스모크 테스트
//   node work/run-pair-judge.mjs --only 07  # 특정 케이스만
import Anthropic from "@anthropic-ai/sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const MODEL = "claude-opus-4-8";
const EFFORT = "high";
const MAX_TOKENS = 4000;
const CONCURRENCY = 4;

const SUITE = "semantic-conflict-pair-judgment-v0.1";
const OUT = "work/pair";

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const LIMIT = getArg("--limit") ? Number(getArg("--limit")) : null;
const ONLY = getArg("--only");

const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(34);
// AI가 패치에서 탭/줄바꿈을 그대로 복사하면 JSON 문자열 안에 제어문자가 들어가 파싱이 깨진다.
// 값 내용은 보존한 채 이스케이프만 복구 (verbatim 매칭에 영향 없음).
function repairControlChars(raw) {
  let out = ""; let inStr = false; let esc = false;
  for (const ch of raw) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === BACKSLASH) { out += ch; esc = true; continue; }
    if (ch === QUOTE) { inStr = !inStr; out += ch; continue; }
    if (inStr) {
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        if (ch === "\t") out += BACKSLASH + "t";
        else if (ch === "\n") out += BACKSLASH + "n";
        else if (ch === "\r") out += BACKSLASH + "r";
        else out += BACKSLASH + "u" + code.toString(16).padStart(4, "0");
        continue;
      }
    }
    out += ch;
  }
  return out;
}
function extractJson(text) {
  const s = text.indexOf("{"); const e = text.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("no JSON object in response");
  const body = text.slice(s, e + 1);
  try { return JSON.parse(body); } catch { return JSON.parse(repairControlChars(body)); }
}

const client = new Anthropic({ timeout: 20 * 60 * 1000, maxRetries: 3 });

const [systemPrompt, userTemplate, inputsRaw] = await Promise.all([
  readFile(`${SUITE}/SYSTEM_PROMPT.txt`, "utf8"),
  readFile(`${SUITE}/USER_PROMPT_TEMPLATE.txt`, "utf8"),
  readFile(`${SUITE}/inputs.jsonl`, "utf8"),
]);
await mkdir(OUT, { recursive: true });

let lines = inputsRaw.split("\n").map((l) => l.trim()).filter(Boolean)
  .map((line, i) => ({ nn: String(i + 1).padStart(2, "0"), line, id: JSON.parse(line).id }));
if (ONLY) lines = lines.filter((x) => x.nn === ONLY);
if (LIMIT) lines = lines.slice(0, LIMIT);

const startedAt = new Date().toISOString();
const t0 = Date.now();
const results = []; const failures = [];

async function judgeOne({ nn, line, id }) {
  // {{CASE_JSON}} 만 치환 — 그 외 프롬프트는 손대지 않는다.
  // 반드시 함수 replacer 를 쓸 것: 문자열 replacer 는 치환값 안의 $&, $`, $', $$ 를
  // 특수 패턴으로 해석해 프롬프트를 오염시킨다(실제로 case 38 패치에 `$&` 가 있어 재현됨).
  const userPrompt = userTemplate.replace("{{CASE_JSON}}", () => line);
  const callStart = Date.now();
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT },
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    // temperature/top_p/top_k: Opus 4.8 에서 제거됨 (전송 시 400)
  });
  const latencyMs = Date.now() - callStart;
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const pred = extractJson(text);
  if (pred.id !== id) throw new Error(`id mismatch: got '${pred.id}' expected '${id}'`);
  await writeFile(`${OUT}/pred-${nn}.json`, JSON.stringify(pred));
  return {
    nn, id, latencyMs, prediction: pred.prediction,
    inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens,
    stopReason: msg.stop_reason,
  };
}

// 동시 실행 제한 풀
let cursor = 0;
async function worker() {
  while (cursor < lines.length) {
    const item = lines[cursor++];
    try {
      const r = await judgeOne(item);
      results.push(r);
      console.log(`✓ ${r.nn} ${r.prediction.padEnd(12)} ${String(r.latencyMs).padStart(6)}ms  in=${r.inputTokens} out=${r.outputTokens}`);
    } catch (err) {
      failures.push({ nn: item.nn, id: item.id, error: String(err?.message ?? err) });
      console.error(`✗ ${item.nn} FAILED: ${err?.message ?? err}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, lines.length) }, worker));

const finishedAt = new Date().toISOString();
const totalLatencyMs = Date.now() - t0;
const totalInput = results.reduce((s, r) => s + r.inputTokens, 0);
const totalOutput = results.reduce((s, r) => s + r.outputTokens, 0);
const meta = {
  model: MODEL, effort: EFFORT, startedAt, finishedAt, totalLatencyMs,
  sumPerCallLatencyMs: results.reduce((s, r) => s + r.latencyMs, 0),
  totalInputTokens: totalInput, totalOutputTokens: totalOutput,
  totalTokens: totalInput + totalOutput,
  completed: results.length, failed: failures.length, failures,
  samplingParams: "none (temperature/top_p/top_k rejected by claude-opus-4-8)",
};
await writeFile("work/pair-run-meta.json", JSON.stringify(meta, null, 2));
console.log(`\n${results.length}/${lines.length} judged | wall ${totalLatencyMs}ms | tokens in=${totalInput} out=${totalOutput}`);
console.log("→ work/pair-run-meta.json (assemble-pair.mjs 가 run.json 에 반영)");
if (failures.length) process.exitCode = 1;