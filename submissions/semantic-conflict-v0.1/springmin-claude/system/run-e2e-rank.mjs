#!/usr/bin/env node
// Test 2 · End-to-End Radar — 실제 LLM 러너
//
// 규칙 준수:
//  - TASK_PROMPT.txt 를 변경 없이 최상위 과업 계약(system)으로 사용
//  - "Development freedom: deterministic analysis / heuristics / LLM calls 조합 가능" 조항에 따라
//    결정적 전처리(analyze-episodes.mjs)로 후보를 좁힌 뒤 LLM 에 랭킹시킨다.
//    (에피소드 원본은 3.3MB/8.3MB — 후자는 1M 컨텍스트를 초과하므로 전량 주입 불가)
//  - temperature: Opus 4.8 은 temperature/top_p/top_k 를 거부(400) → 전송하지 않음
//  - latency/token 은 응답에서 실측
//
// 선행: node work/analyze-episodes.mjs   (후보 dossier + -top.json 생성)
// 사용: export ANTHROPIC_API_KEY=sk-ant-... && node work/run-e2e-rank.mjs
import Anthropic from "@anthropic-ai/sdk";
import { readFile, writeFile } from "node:fs/promises";

const MODEL = "claude-opus-4-8";
const EFFORT = "high";
const MAX_TOKENS = 16000;
const SUITE = "semantic-conflict-end-to-end-v0.1";
const EPISODES = ["episode-01", "episode-02"];

function extractJsonArray(text) {
  const s = text.indexOf("["); const e = text.lastIndexOf("]");
  if (s < 0 || e < 0) throw new Error("no JSON array in response");
  return JSON.parse(text.slice(s, e + 1));
}

const client = new Anthropic({ timeout: 20 * 60 * 1000, maxRetries: 3 });
const taskPrompt = await readFile(`${SUITE}/TASK_PROMPT.txt`, "utf8");

const startedAt = new Date().toISOString();
const t0 = Date.now();
const runs = []; const failures = [];

for (const ep of EPISODES) {
  const dossier = await readFile(`work/e2e/${ep}-candidates.md`, "utf8");
  const auth = JSON.parse(await readFile(`work/e2e/${ep}-top.json`, "utf8"));

  const userPrompt = [
    "Below is a deterministic pre-analysis of one episode. All 780 pairs were considered;",
    "cross-module pairs are isolated by construction and were excluded. The remaining",
    `${auth.length} same-module candidate pairs are listed with shared-file hunks, symbols`,
    "changed by both sides, and def<->call cross signals.",
    "",
    `Rank ALL ${auth.length} pairs from most to least likely to be a pair-induced semantic`,
    "conflict per the constitution. Same-module pairs include both real historical conflicts",
    "and hard negatives — judge the concrete causal interaction, not proximity.",
    "",
    `Return ONLY a JSON array of exactly ${auth.length} objects, ordered rank 1 (most likely) first:`,
    '[{"prA":"PR-XXX","prB":"PR-YYY","decision":"conflict|review|independent|insufficient|coordination",',
    '  "confidence":0.0-1.0,"explanation":"one sentence naming the concrete causal interaction"}]',
    "Use the exact prA/prB ids from the dossier. Include each pair exactly once. No markdown.",
    "",
    "=== EPISODE CANDIDATE DOSSIER ===",
    dossier,
  ].join("\n");

  const callStart = Date.now();
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT },
      system: taskPrompt,           // 고정 과업 계약, 변경 없음
      messages: [{ role: "user", content: userPrompt }],
      // temperature/top_p/top_k: Opus 4.8 에서 제거됨 (전송 시 400)
    });
    const latencyMs = Date.now() - callStart;
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const ranked = extractJsonArray(text);
    await writeFile(`work/e2e/${ep}-ranked.json`, JSON.stringify(ranked, null, 2));
    runs.push({
      episode: ep, latencyMs, ranked: ranked.length, expected: auth.length,
      inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens,
      stopReason: msg.stop_reason,
    });
    console.log(`✓ ${ep}: ${ranked.length}/${auth.length} ranked | ${latencyMs}ms | in=${msg.usage.input_tokens} out=${msg.usage.output_tokens}`);
  } catch (err) {
    failures.push({ episode: ep, error: String(err?.message ?? err) });
    console.error(`✗ ${ep} FAILED: ${err?.message ?? err}`);
  }
}

const meta = {
  model: MODEL, effort: EFFORT, startedAt, finishedAt: new Date().toISOString(),
  totalLatencyMs: Date.now() - t0,
  totalInputTokens: runs.reduce((s, r) => s + r.inputTokens, 0),
  totalOutputTokens: runs.reduce((s, r) => s + r.outputTokens, 0),
  episodeRuns: runs, failed: failures.length, failures,
  samplingParams: "none (temperature/top_p/top_k rejected by claude-opus-4-8)",
};
await writeFile("work/e2e-run-meta.json", JSON.stringify(meta, null, 2));
console.log("\n→ work/e2e-run-meta.json | 다음: node work/assemble-e2e.mjs");
if (failures.length) process.exitCode = 1;