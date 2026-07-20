#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allowedHumanDecisions, buildPromotionCandidate, mergePromotions } from "./improvement-lifecycle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (flag, fallback = null) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : fallback; };
const has = (flag) => args.includes(flag);
const readJsonl = async (path) => (await readFile(path, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
const jsonl = (rows) => rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";

async function latest(root) {
  const names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  if (!names.length) throw new Error(`no run directories in ${root}`);
  return join(root, names[0]);
}

function execute(program, commandArgs, cwd) {
  return new Promise((done) => {
    const child = spawn(program, commandArgs, { cwd, env: process.env, stdio: "inherit" });
    child.on("error", () => done(1));
    child.on("close", done);
  });
}

async function main() {
  const verificationRun = resolve(value("--verification-run", await latest(join(ROOT, ".cache", "live-verification-runs"))));
  const results = await readJsonl(join(verificationRun, "results.jsonl"));
  const decisionsPath = value("--human-decisions");
  const decisions = decisionsPath ? await readJsonl(resolve(decisionsPath)) : [];
  const decisionByCase = new Map(decisions.filter((item) => item.caseId).map((item) => [item.caseId, item.decision]));
  const promotionQuestions = results.filter((result) => ["conflict", "compatible"].includes(result.verification?.classification?.verdict)).map((result) => {
    const verdict = result.verification.classification.verdict;
    return {
      id: `promote-${result.actionId}`,
      kind: verdict === "conflict" ? "conflict-promotion-adjudication" : "compatible-promotion-adjudication",
      caseId: result.finding?.logicalKey,
      question: verdict === "conflict"
        ? `${result.finding?.logicalKey}의 A+B 반복 실패가 두 PR의 상호작용에서 발생한 것인지 확인해 frozen conflict gold로 승격할까요?`
        : `${result.finding?.logicalKey}는 Base/A/B/A+B 테스트 범위에서 통과했습니다. diff와 테스트 범위도 확인해 frozen harmless gold로 승격할까요?`,
      context: { repository: result.repository, classification: result.verification.classification },
    };
  });
  for (const question of promotionQuestions) {
    const decision = decisionByCase.get(question.caseId);
    if (decision && !allowedHumanDecisions(question).includes(decision)) {
      throw new Error(`${question.caseId}: unsupported promotion decision '${decision}' (allowed: ${allowedHumanDecisions(question).join(", ")})`);
    }
  }
  const pendingQuestions = promotionQuestions.filter((question) => !decisionByCase.has(question.caseId));
  await writeFile(join(verificationRun, "promotion-questions.jsonl"), jsonl(pendingQuestions));
  if (pendingQuestions.length) {
    console.log(`Human promotion questions: ${pendingQuestions.length}`);
    console.log(`Questions: ${join(verificationRun, "promotion-questions.jsonl")}`);
    process.exitCode = 2;
    return;
  }
  const sourceSuite = resolve(value("--source-suite", join(ROOT, "benchmarks", "semantic-clean-v0.1", "frozen-v0.1")));
  const [existingInputs, existingGold] = await Promise.all([readJsonl(join(sourceSuite, "inputs.jsonl")), readJsonl(join(sourceSuite, "gold.jsonl"))]);
  const candidates = results.map((result) => buildPromotionCandidate({
    repository: result.repository,
    input: result.input,
    verification: result.verification,
    finding: result.finding,
    humanDecision: decisionByCase.get(result.finding?.logicalKey) || null,
  })).filter(Boolean);
  const merged = mergePromotions(existingInputs, existingGold, candidates);
  if (!merged.added) {
    console.log("No promotable cases. Conflict requires human causal approval; compatible requires a human harmless decision.");
    return;
  }
  const version = value("--version", `promoted-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const output = resolve(value("--output", join(ROOT, "benchmarks", "semantic-clean-v0.1", version)));
  await mkdir(output, { recursive: false });
  await Promise.all([
    writeFile(join(output, "inputs.jsonl"), jsonl(merged.inputs)),
    writeFile(join(output, "gold.jsonl"), jsonl(merged.gold)),
    writeFile(join(output, "promotion.json"), `${JSON.stringify({ schemaVersion: "benchmark-promotion-v0.1", sourceSuite, verificationRun, generatedAt: new Date().toISOString(), previousCases: existingInputs.length, addedCases: merged.added, totalCases: merged.inputs.length }, null, 2)}\n`),
  ]);
  const deterministicCode = await execute("node", ["eval/run-daily-performance.mjs", "--suite", output, "--output-root", join(output, "baseline-deterministic")], ROOT);
  if (deterministicCode !== 0) throw new Error("promoted deterministic baseline failed");
  if (!has("--skip-ai")) {
    const aiCode = await execute("node", ["eval/run-daily-ai-performance.mjs", "--suite", output, "--output-root", join(output, "baseline-ai"), "--model", value("--model", process.env.CODEX_MODEL || "gpt-5.6-sol"), "--codex-bin", value("--codex-bin", process.env.CODEX_BIN || "codex"), "--repeats", value("--repeats", "3"), "--concurrency", value("--concurrency", "4")], ROOT);
    if (aiCode !== 0) throw new Error("promoted AI baseline failed");
  }
  console.log(`Promoted cases: ${merged.added}`);
  console.log(`New immutable suite: ${output}`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
