#!/usr/bin/env node
// 결정적 층이 뽑은 후보쌍을 Claude(Anthropic)로 second-look 판정한다.
// 전체 재스캔(느린 merge-tree 2,701쌍)을 반복하지 않고, 이미 추출된 후보의
// verbatim evidence 를 그대로 Claude 에 넘겨 conflict 실재/유형/신뢰도를 받는다.
//
// 앱 src/anthropic.mjs 의 검증된 호출 규약을 재사용:
//   claude-opus-4-8 · thinking adaptive · output_config.effort · temperature 없음(400 회피)
//
// 사용: node eval/judge-anthropic-candidates.mjs [--repeats 3] [--effort medium] [--in reports/_candidates-fineract.json]
import { readFile, writeFile } from "node:fs/promises";

// ── .env 로드 (앱 본체는 .env 를 읽지 않음. gitignore 등록됨) ──
async function loadDotEnv(path = ".env") {
  let text; try { text = await readFile(path, "utf8"); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("="); if (eq < 1) continue;
    const k = line.slice(0, eq).trim(); let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!v || v.includes("...") || process.env[k]) continue;
    process.env[k] = v;
  }
}
await loadDotEnv();

const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; };
const REPEATS = Number(arg("--repeats", 3));
const EFFORT = arg("--effort", "medium");
const INPUT = arg("--in", "reports/_candidates-fineract.json");
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY 필요 (.env)"); process.exit(1); }

const candidates = JSON.parse(await readFile(INPUT, "utf8"));

// ── JSON object 추출 (앱 extractJsonObject 규약) ──
function extractJsonObject(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < s) throw new Error("응답에 JSON 없음");
  return JSON.parse(text.slice(s, e + 1));
}

const SYSTEM = [
  "당신은 두 개의 PR(A, B)이 각각 단독으로는 CI 초록불·git clean 인데 함께 병합하면 깨지는지를 판정하는 심사자다.",
  "아래 단 하나의 PR pair 만 판정한다. 다른 pair 나 일반적 위험을 추론하지 마라.",
  "판정은 제공된 verbatim 코드 인용에만 근거한다. 인용에 없는 코드를 상상하지 마라.",
  "특히 두 유형을 구분하라:",
  " - compile-level: A+B 가 Java 정적 타입에서 컴파일 에러(없는 메서드 호출, 중복 선언 등). CI 가 병합 후 잡으므로 직접 런타임 금액 손실은 보수적으로 0.",
  " - silent-runtime: A+B 가 컴파일·테스트를 다 통과하는데 런타임 로직만 틀림. 이것이 진짜 임팩트(silent) 케이스다.",
  "다음 JSON object 하나만 반환하라:",
  '{"prIds":[A,B],"isConflict":true|false,"conflictType":"compile-level|silent-runtime|none","onMoneyPath":true|false,"moneyPathReason":"...","confidence":0.0,"changedSide":"A|B|both|unknown","reasoning":"2~3문장","keyQuote":"판정 근거가 된 verbatim 인용"}',
].join("\n");

function userPrompt(c) {
  return [
    "CASE:",
    `PR-A = #${c.prs[0]} — ${c.titles[0]}`,
    `PR-B = #${c.prs[1]} — ${c.titles[1]}`,
    `결정적 분석 요약: ${c.summary}`,
    `결정적 분석 제목: ${c.title}`,
    `카테고리: ${c.category}`,
    "verbatim evidence (파일 경로 + 실제 코드 인용):",
    ...c.evidence.map((e) => "  - " + e),
    "",
    "위 pair 가 실제 pair-induced conflict 인지, compile-level 인지 silent-runtime 인지, 금융(금액) 경로에 닿는지 판정하라.",
  ].join("\n");
}

const { default: Anthropic } = await import("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 10 * 60 * 1000, maxRetries: 2 });

async function judgeOnce(c) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2500,
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT },
    system: SYSTEM,
    messages: [{ role: "user", content: userPrompt(c) }],
  });
  const text = (message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const usage = message.usage || {};
  return { verdict: extractJsonObject(text), usage };
}

console.log(`Claude second-look: ${candidates.length}쌍 × ${REPEATS}회 = ${candidates.length * REPEATS} calls | model ${MODEL} | effort ${EFFORT}`);
const results = [];
let inTok = 0, outTok = 0;
for (const c of candidates) {
  const tag = `#${c.prs.join(" x #")}`;
  const runs = [];
  for (let r = 0; r < REPEATS; r++) {
    try {
      const { verdict, usage } = await judgeOnce(c);
      inTok += usage.input_tokens || 0; outTok += usage.output_tokens || 0;
      runs.push(verdict);
      process.stdout.write(`  ${tag} run${r + 1}: ${verdict.isConflict ? verdict.conflictType : "not-conflict"}${verdict.onMoneyPath ? " 💰" : ""} (conf ${verdict.confidence})\n`);
    } catch (e) {
      runs.push({ error: String(e).slice(0, 200) });
      process.stdout.write(`  ${tag} run${r + 1}: ERROR ${String(e).slice(0, 120)}\n`);
    }
  }
  // 안정성: isConflict + conflictType 이 모든 run 에서 동일한가
  const keys = runs.map((v) => v.error ? "err" : `${v.isConflict}/${v.conflictType}`);
  const stable = new Set(keys).size === 1 && !keys.includes("err");
  results.push({ prs: c.prs, titles: c.titles, category: c.category, summary: c.summary, runs, stable, verdicts: keys });
}

const stamp = "2026-07-27";
await writeFile(`reports/_anthropic-judge-${stamp}.json`,
  JSON.stringify({ model: MODEL, effort: EFFORT, repeats: REPEATS, usage: { input: inTok, output: outTok }, results }, null, 2));
console.log(`\n토큰: input ${inTok.toLocaleString()} / output ${outTok.toLocaleString()}`);
console.log(`결과: reports/_anthropic-judge-${stamp}.json`);