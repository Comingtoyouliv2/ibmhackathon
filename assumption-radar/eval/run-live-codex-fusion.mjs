#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { analyzeWithCodex } from "../src/codex.mjs";
import { prepareIntegratedAnalysis } from "../src/integrated.mjs";
import { AI_JUDGMENT_PROTOCOL_VERSION, semanticJudgeRepeatCount } from "../src/semantic-judge.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const inputPath = resolve(value("--inputs", "handoff/semantic-conflict-pair-judgment-v0.1/inputs.jsonl"));
const promptHashPath = resolve(value("--prompt-hash", join(dirname(inputPath), "PROMPT_SHA256.txt")));
const output = resolve(value("--output", "benchmarks/comparisons/integrated-v0.2-codex-live/pair"));
const model = value("--model", process.env.CODEX_MODEL || "gpt-5.4");
const reasoningEffort = value("--reasoning-effort", "medium");
const concurrency = Math.max(1, Math.min(8, Number(value("--concurrency", "4"))));
const aiRepeats = semanticJudgeRepeatCount({ aiRepeats: value("--ai-repeats", process.env.AI_JUDGE_REPEATS) });
const limit = Math.max(0, Number(value("--limit", "0")));

const [inputText, promptSha256] = await Promise.all([
  readFile(inputPath, "utf8"),
  readFile(promptHashPath, "utf8").then((text) => text.trim()),
]);
const records = inputText.split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
const selected = limit ? records.slice(0, limit) : records;
const predictions = new Array(selected.length);
const failures = [];
let cursor = 0;
let modelCalls = 0;
const startedAt = new Date();
const totalStarted = performance.now();

function containsQuote(value, quote) {
  if (typeof value === "string") return value.includes(quote);
  if (Array.isArray(value)) return value.some((item) => containsQuote(item, quote));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsQuote(item, quote));
  return false;
}

function fallbackEvidence(record) {
  return record.prs.map((pr, index) => {
    const file = pr.files?.find((item) => item.patch) ?? pr.files?.[0];
    const quote = file?.patch?.split("\n").find((line) => /^[+-](?![+-])/.test(line) && line.length > 1) ?? pr.title;
    return { side: index === 0 ? "A" : "B", file: file?.filename ?? "", symbol: "", quote };
  }).filter((item) => item.quote);
}

function submissionEvidence(resolved, record) {
  if (!["conflict", "review", "coordination"].includes(resolved.verdict)) return [];
  const valid = (resolved.evidenceObjects ?? []).filter((item) => {
    const pr = record.prs[item.side === "A" ? 0 : 1];
    return pr && item.quote && containsQuote(pr, item.quote);
  });
  const sides = new Set(valid.map((item) => item.side));
  return sides.has("A") && sides.has("B") ? valid : fallbackEvidence(record);
}

async function worker() {
  while (cursor < selected.length) {
    const index = cursor++;
    const record = selected[index];
    const started = performance.now();
    try {
      const prepared = prepareIntegratedAnalysis(record.prs);
      const deterministic = prepared.comparisons[0];
      const judgments = await analyzeWithCodex(prepared, { model, reasoningEffort, concurrency: 1, aiRepeats });
      modelCalls += judgments.reduce((count, item) => count + (item.aiProtocol?.requestedRepeats || 0), 0);
      const resolved = deterministic.verdict === "conflict" && deterministic.basis === "deterministic-witness"
        ? deterministic : judgments[0] || deterministic;
      predictions[index] = {
        schemaVersion: "pair-qualification-prediction-v0.1",
        id: record.id,
        prediction: resolved.verdict,
        confidence: resolved.confidence ?? 0.8,
        assumptionA: resolved.assumptionA || "",
        assumptionB: resolved.assumptionB || "",
        failureMechanism: resolved.consequence || "",
        explanation: resolved.summary || "",
        evidence: submissionEvidence(resolved, record),
        latencyMs: performance.now() - started,
        tokens: null,
        costUsd: null,
      };
      console.log(`Codex fusion ${index + 1}/${selected.length}: ${resolved.verdict}`);
    } catch (error) {
      failures.push({ id: record.id, error: error.message });
      console.error(`Codex fusion ${index + 1}/${selected.length}: ${error.message}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));
const completed = predictions.filter(Boolean);
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(join(output, "predictions.jsonl"), `${completed.map((row) => JSON.stringify(row)).join("\n")}\n`),
  writeFile(join(output, "run.json"), `${JSON.stringify({
    schemaVersion: "pair-qualification-run-v0.1",
    systemName: "integrated-v0.2-codex-live",
    version: "integrated-v0.2",
    model,
    aiJudgmentProtocol: AI_JUDGMENT_PROTOCOL_VERSION,
    aiRepeats,
    unanimityRequired: true,
    promptSha256,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    totalLatencyMs: performance.now() - totalStarted,
    totalTokens: null,
    totalCostUsd: null,
    failedCases: failures.length,
    modelCalls,
    failures,
    notes: "Fresh isolated Codex CLI calls over public pair inputs. The prompt hash identifies the public evaluation protocol; deterministic blockers bypass AI, while high-retrieval unresolved pairs use the system's bounded internal Codex second-look prompt.",
  }, null, 2)}\n`),
]);
console.log(`Live Codex fusion: ${completed}/${selected.length} cases, ${modelCalls} model calls → ${output}`);
if (failures.length) process.exitCode = 1;
