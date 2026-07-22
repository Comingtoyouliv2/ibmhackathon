#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { analyzeWithAI } from "../src/ai.mjs";
import { finishAnalysis } from "../src/analyzer.mjs";
import { prepareIntegratedAnalysis } from "../src/integrated.mjs";
import { applyMergeTreeResults } from "../src/pipeline.mjs";
import { AI_JUDGMENT_PROTOCOL_VERSION, semanticJudgeRepeatCount } from "../src/semantic-judge.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const optionNames = new Set(["--provider", "--model", "--ai-repeats", "--concurrency", "--output"]);
const inputPaths = args.filter((arg, index) => !arg.startsWith("--") && !optionNames.has(args[index - 1])).map((arg) => resolve(arg));
if (!inputPaths.length) throw new Error("하나 이상의 snapshot inputs.jsonl 경로가 필요합니다.");

const provider = value("--provider", "codex");
const model = value("--model", provider === "codex" ? process.env.CODEX_MODEL || "gpt-5.4" : undefined);
const aiRepeats = semanticJudgeRepeatCount({ aiRepeats: value("--ai-repeats", process.env.AI_JUDGE_REPEATS) });
const concurrency = Math.max(1, Math.min(8, Number(value("--concurrency", "4"))));
const outputDir = resolve(value("--output", `benchmarks/comparisons/common-protocol-${new Date().toISOString().replace(/[:.]/g, "-")}`));

async function loadInput(inputPath) {
  const records = (await readFile(inputPath, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
  if (records.length !== 1 || !Array.isArray(records[0].prs)) throw new Error(`지원하지 않는 snapshot 입력입니다: ${inputPath}`);
  return records[0];
}

function needsPairContext(comparison) {
  return comparison.witnesses.length > 0
    || ((comparison.retrievalScore || 0) > 0 && (comparison.retrievalFeatures?.priority ?? 3) <= 1);
}

async function replayPrepared(inputPath, input) {
  const snapshot = JSON.parse(await readFile(join(dirname(inputPath), "snapshot.json"), "utf8"));
  const suppressed = new Set(snapshot.preflight?.suppressedPrNumbers || []);
  const prs = input.prs.filter((pr) => !suppressed.has(Number(pr.number)));
  const prepared = prepareIntegratedAnalysis(prs);
  const prById = new Map(prepared.prs.map((pr) => [pr.id, pr]));
  const idByNumber = new Map(prepared.prs.map((pr) => [Number(pr.number), pr.id]));
  const baseConflicts = new Set(snapshot.preflight?.baseConflictPrNumbers || []);
  const coordination = new Map((snapshot.findings || [])
    .filter((finding) => finding.verdict === "coordination" || finding.source === "git-preflight")
    .map((finding) => [(finding.prIds || finding.prNumbers?.map((number) => idByNumber.get(Number(number)))).filter(Boolean).sort().join(":"), finding])
    .filter(([key]) => key));
  const inspections = prepared.comparisons.filter(needsPairContext).map((comparison) => {
    const left = prById.get(comparison.prIds[0]);
    const right = prById.get(comparison.prIds[1]);
    const numbers = [Number(left.number), Number(right.number)];
    const conflicting = numbers.filter((number) => baseConflicts.has(number));
    if (conflicting.length) return {
      key: comparison.key, status: "base-conflict", prNumbers: numbers,
      baseConflictPrNumbers: conflicting, conflictPaths: [], messages: [],
    };
    if ((left.base || "main") !== (right.base || "main")) return {
      key: comparison.key, status: "unavailable", prNumbers: numbers,
      error: "PRs target different base branches",
    };
    const finding = coordination.get(comparison.key);
    if (finding) return {
      key: comparison.key, status: "textual-conflict", prNumbers: numbers,
      conflictPaths: finding.preflight?.conflictPaths || finding.evidence || [],
      messages: finding.preflight?.messages || [],
    };
    return { key: comparison.key, status: "clean", prNumbers: numbers, conflictPaths: [], messages: [] };
  });
  return { prepared: applyMergeTreeResults(prepared, inspections), preflight: { ...snapshot.preflight, replayed: true } };
}

function compactFinding(finding, prsById) {
  return {
    pair: finding.prIds.map((id) => prsById.get(id)?.number || id),
    verdict: finding.verdict,
    relationship: finding.relationship || null,
    title: finding.title,
    basis: finding.basis,
    source: finding.source,
    aiProtocol: finding.aiProtocol || null,
    runtimeVerification: finding.runtimeVerification || null,
  };
}

const results = [];
for (const inputPath of inputPaths) {
  const input = await loadInput(inputPath);
  const repository = input.repository;
  const pipeline = await replayPrepared(inputPath, input);
  const deterministic = finishAnalysis(pipeline.prepared);
  const aiJudgments = await analyzeWithAI(pipeline.prepared, {
    aiProvider: provider,
    model,
    aiRepeats,
    concurrency,
  });
  const resolved = finishAnalysis(pipeline.prepared, aiJudgments);
  const prsById = new Map(resolved.prs.map((pr) => [pr.id, pr]));
  const record = {
    repository,
    inputPath,
    snapshotGeneratedAt: input.generatedAt || null,
    model,
    provider,
    protocol: {
      version: AI_JUDGMENT_PROTOCOL_VERSION,
      deterministicRuns: 1,
      aiRepeats,
      unanimityRequired: true,
    },
    preflight: pipeline.preflight,
    deterministicSummary: deterministic.summary,
    finalSummary: resolved.summary,
    aiCandidateCount: aiJudgments.length,
    stableAiCount: aiJudgments.filter((item) => item.aiProtocol?.stable).length,
    unstableAiCount: aiJudgments.filter((item) => item.aiProtocol && !item.aiProtocol.stable).length,
    findings: resolved.findings.map((finding) => compactFinding(finding, prsById)),
  };
  results.push(record);
  console.log(`${repository}: ${record.finalSummary.conflictCount} conflict · ${record.finalSummary.reviewCount} review · ${record.unstableAiCount} unstable AI`);
}

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "results.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
const rows = results.map((item) => `| ${item.repository} | ${item.finalSummary.prCount} | ${item.finalSummary.pairCount} | ${item.finalSummary.conflictCount} | ${item.finalSummary.reviewCount} | ${item.finalSummary.coordinationCount} | ${item.aiCandidateCount} | ${item.stableAiCount} | ${item.unstableAiCount} |`).join("\n");
const report = `# 공통 AI 판정 프로토콜 snapshot replay\n\n- Provider/model: ${provider} / ${model}\n- AI repeats: ${aiRepeats}\n- Stability: 모든 반복이 같은 assessment일 때만 stable\n- Inputs: 고정 snapshot 및 기존 Git cache; network refetch 없음\n\n| Repository | PR | Pair | Conflict | Review | Coordination | AI candidates | Stable AI | Unstable AI |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n> Conflict는 contract-backed static을 포함할 수 있으며, Base/A/B/A+B 실행 확정과는 구분합니다.\n`;
await writeFile(join(outputDir, "report.md"), report);
console.log(`Common protocol replay complete: ${outputDir}`);
