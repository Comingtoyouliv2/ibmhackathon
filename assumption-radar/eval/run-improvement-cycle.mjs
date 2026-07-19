#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (flag, fallback = null) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : fallback; };
const has = (flag) => args.includes(flag);

async function latest(root) {
  const names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  if (!names.length) return null;
  return join(root, names[0]);
}

function run(script, scriptArgs = []) {
  return new Promise((done) => {
    const child = spawn("node", [script, ...scriptArgs], { cwd: ROOT, env: process.env, stdio: "inherit" });
    child.on("error", (error) => done({ code: 1, error: error.message }));
    child.on("close", (code) => done({ code }));
  });
}

async function lineCount(path) {
  try { return (await readFile(path, "utf8")).split("\n").filter((line) => line.trim()).length; }
  catch { return 0; }
}

async function main() {
  const cycleRoot = resolve(value("--output-root", join(ROOT, ".cache", "improvement-cycles")));
  const cycle = join(cycleRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(cycle, { recursive: true });
  const stages = [];
  let harness = value("--harness-run");
  if (!harness) {
    const result = await run("eval/run-improvement-harness.mjs");
    stages.push({ stage: "route", status: result.code === 0 ? "passed" : "failed", exitCode: result.code });
    if (result.code !== 0) throw new Error("routing stage failed");
    harness = await latest(join(ROOT, ".cache", "improvement-harness"));
  }
  harness = resolve(harness);

  const humanArgs = ["--harness-run", harness];
  if (value("--answers")) humanArgs.push("--answers", resolve(value("--answers")));
  if (has("--interactive")) humanArgs.push("--interactive");
  const human = await run("eval/run-human-adjudication.mjs", humanArgs);
  stages.push({ stage: "human-adjudication", status: human.code === 0 ? "passed" : human.code === 2 ? "awaiting-human" : "failed", exitCode: human.code });
  if (human.code === 1) throw new Error("human adjudication contract failed");

  if (!has("--skip-agent") && (await lineCount(join(harness, "code-actions.jsonl")) || await lineCount(join(harness, "prompt-actions.jsonl")))) {
    const agentArgs = ["--harness-run", harness, "--model", value("--model", process.env.CODEX_MODEL || "gpt-5.6-sol"), "--codex-bin", value("--codex-bin", process.env.CODEX_BIN || "codex")];
    if (has("--apply")) agentArgs.push("--apply");
    if (has("--skip-ai")) agentArgs.push("--skip-ai");
    const agent = await run("eval/run-improvement-execution.mjs", agentArgs);
    stages.push({ stage: "candidate-improvement", status: agent.code === 0 ? "passed" : agent.code === 3 ? "rejected" : "failed", exitCode: agent.code });
  } else stages.push({ stage: "candidate-improvement", status: "not-needed" });

  let verificationRun = null;
  if (!has("--skip-verification") && await lineCount(join(harness, "verification-actions.jsonl"))) {
    const verifyArgs = ["--harness-run", harness];
    if (value("--verification-profile")) verifyArgs.push("--verification-profile", resolve(value("--verification-profile")));
    const verification = await run("eval/run-live-verification-actions.mjs", verifyArgs);
    verificationRun = await latest(join(ROOT, ".cache", "live-verification-runs"));
    stages.push({ stage: "live-verification", status: verification.code === 0 ? "passed" : verification.code === 2 ? "incomplete" : "failed", exitCode: verification.code });
  } else stages.push({ stage: "live-verification", status: "not-needed" });

  if (verificationRun && await lineCount(join(verificationRun, "results.jsonl"))) {
    const promoteArgs = ["--verification-run", verificationRun, "--model", value("--model", process.env.CODEX_MODEL || "gpt-5.6-sol"), "--codex-bin", value("--codex-bin", process.env.CODEX_BIN || "codex")];
    if (value("--answers")) promoteArgs.push("--human-decisions", resolve(value("--answers")));
    if (has("--skip-ai")) promoteArgs.push("--skip-ai");
    const promotion = await run("eval/run-benchmark-promotion.mjs", promoteArgs);
    stages.push({ stage: "benchmark-promotion", status: promotion.code === 0 ? "passed" : "failed", exitCode: promotion.code });
  } else stages.push({ stage: "benchmark-promotion", status: "not-needed" });

  const status = stages.some((stage) => stage.status === "failed") ? "failed"
    : stages.some((stage) => stage.status === "awaiting-human") ? "awaiting-human"
      : stages.some((stage) => stage.status === "rejected" || stage.status === "incomplete") ? "needs-attention" : "complete";
  const state = { schemaVersion: "improvement-cycle-v0.1", generatedAt: new Date().toISOString(), harness, status, stages };
  await writeFile(join(cycle, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  console.log(`Cycle status: ${status}`);
  console.log(`State: ${join(cycle, "state.json")}`);
  if (status !== "complete") process.exitCode = 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
