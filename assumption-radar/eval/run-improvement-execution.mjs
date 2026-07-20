#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { evaluateCandidateGate } from "./improvement-lifecycle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (flag, fallback = null) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : fallback; };
const has = (flag) => args.includes(flag);
const readJsonl = async (path) => (await readFile(path, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
const sha = (value) => createHash("sha256").update(value).digest("hex");

async function latest(root) {
  const names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  if (!names.length) throw new Error(`no run directories in ${root}`);
  return join(root, names[0]);
}

function execute(program, commandArgs, options = {}) {
  return new Promise((done) => {
    const child = spawn(program, commandArgs, { cwd: options.cwd, env: options.env || process.env, stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    let finished = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, options.timeoutMs || 15 * 60_000);
    timeout.unref();
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const finish = (result) => { if (finished) return; finished = true; clearTimeout(timeout); done(result); };
    child.on("error", (error) => finish({ code: null, stdout, stderr: `${stderr}\n${error.message}` }));
    child.on("close", (code, signal) => finish({ code, signal, stdout, stderr }));
    if (options.stdin) child.stdin.end(options.stdin);
  });
}

async function copyWorkspace(destination) {
  await cp(ROOT, destination, {
    recursive: true,
    filter: (source) => {
      const rel = relative(ROOT, source);
      return !rel || ![".cache", "node_modules", "reports"].some((prefix) => rel === prefix || rel.startsWith(`${prefix}${sep}`));
    },
  });
  try {
    const modules = join(ROOT, "node_modules");
    const stat = await lstat(modules);
    await symlink(stat.isSymbolicLink() ? await readlink(modules) : modules, join(destination, "node_modules"));
  } catch { /* The current test suite does not require installed dependencies. */ }
}

async function filesUnder(root, prefixes = ["src", "test", "eval"]) {
  const result = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) result.push(relative(root, child));
    }
  }
  for (const prefix of prefixes) {
    try { await walk(join(root, prefix)); } catch { /* optional */ }
  }
  return result.sort();
}

async function changedFiles(original, candidate) {
  const paths = new Set([...(await filesUnder(original)), ...(await filesUnder(candidate))]);
  const changed = [];
  for (const path of paths) {
    let before = null; let after = null;
    try { before = await readFile(join(original, path)); } catch { /* new file */ }
    try { after = await readFile(join(candidate, path)); } catch { /* deleted file */ }
    if ((before && after && Buffer.compare(before, after) === 0) || (!before && !after)) continue;
    changed.push({ path, beforeSha256: before ? sha(before) : null, afterSha256: after ? sha(after) : null, deleted: !after });
  }
  return changed;
}

function improvementPrompt(actions, cases) {
  return [
    "You are improving Assumption Radar's semantic PR-conflict detector.",
    "Edit this isolated workspace. Implement general rules, never case-ID special cases or repository-name allowlists.",
    "You may edit only the target src files named in the actions and focused test/*.test.mjs files.",
    "Add positive and hard-negative tests. Do not edit benchmarks, eval runners, package.json, or generated outputs.",
    "Finish with a concise summary. The outer harness will run the complete tests and frozen benchmark.",
    "",
    `ACTIONS=${JSON.stringify(actions)}`,
    `TARGET_CASES=${JSON.stringify(cases)}`,
  ].join("\n");
}

async function runCodex(candidate, actions, cases) {
  const codexBin = value("--codex-bin", process.env.CODEX_BIN || "codex");
  const model = value("--model", process.env.CODEX_MODEL || "gpt-5.6-sol");
  return execute(codexBin, [
    "exec", "-", "--model", model,
    "-c", `model_reasoning_effort=\"${value("--reasoning-effort", "high")}\"`,
    "--ignore-user-config", "--ignore-rules", "--ephemeral",
    "--sandbox", "workspace-write", "--skip-git-repo-check", "--cd", candidate, "--color", "never",
  ], { cwd: candidate, stdin: improvementPrompt(actions, cases), timeoutMs: Number(value("--agent-timeout-ms", 15 * 60_000)) });
}

async function main() {
  const harness = resolve(value("--harness-run", await latest(join(ROOT, ".cache", "improvement-harness"))));
  const [run, codeActions, promptActions] = await Promise.all([
    readFile(join(harness, "run.json"), "utf8").then(JSON.parse),
    readJsonl(join(harness, "code-actions.jsonl")),
    readJsonl(join(harness, "prompt-actions.jsonl")),
  ]);
  const actions = [...codeActions, ...promptActions];
  if (!actions.length) { console.log("No code or prompt actions."); return; }
  const targetIds = [...new Set(actions.map((action) => action.caseId).filter(Boolean))];
  const suite = join(ROOT, "benchmarks", "semantic-clean-v0.1", "frozen-v0.1");
  const [inputs, gold] = await Promise.all([readJsonl(join(suite, "inputs.jsonl")), readJsonl(join(suite, "gold.jsonl"))]);
  const targetCases = inputs.filter((record) => targetIds.includes(record.id));
  const deterministicBaseline = run.performanceRuns.find((path) => path.includes("semantic-clean-v0.1/") && !path.includes("semantic-clean-v0.1-ai"));
  const aiBaseline = run.performanceRuns.find((path) => path.includes("semantic-clean-v0.1-ai"));
  if (!deterministicBaseline) throw new Error("deterministic baseline is required");

  const outputRoot = resolve(value("--output-root", join(ROOT, ".cache", "improvement-executions")));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const output = join(outputRoot, runId);
  const temporary = await mkdtemp(join(tmpdir(), "assumption-radar-improve-"));
  const candidate = join(temporary, "candidate");
  await mkdir(output, { recursive: true });
  try {
    await copyWorkspace(candidate);
    const candidateRun = value("--candidate-run");
    if (candidateRun) {
      const priorRoot = resolve(candidateRun);
      const prior = JSON.parse(await readFile(join(priorRoot, "result.json"), "utf8"));
      for (const change of prior.changed || []) {
        if (change.deleted) { await rm(join(candidate, change.path)); continue; }
        const source = join(priorRoot, "candidate-files", change.path);
        await mkdir(dirname(join(candidate, change.path)), { recursive: true });
        await copyFile(source, join(candidate, change.path));
      }
      await writeFile(join(output, "agent.log"), `Reused candidate from ${priorRoot}\n`);
    } else {
      const proposal = await runCodex(candidate, actions, targetCases);
      await writeFile(join(output, "agent.log"), `${proposal.stdout}\n${proposal.stderr}`);
      if (proposal.code !== 0) throw new Error(`improvement agent failed (${proposal.code}); see ${join(output, "agent.log")}`);
    }
    const changed = await changedFiles(ROOT, candidate);
    const allowedTargets = new Set(actions.flatMap((action) => action.targetFiles || []));
    const unauthorized = changed.filter((item) => !allowedTargets.has(item.path) && !/^test\/.*\.test\.mjs$/.test(item.path));
    if (!changed.length) throw new Error("improvement agent produced no changes");
    if (unauthorized.length) throw new Error(`agent changed unauthorized files: ${unauthorized.map((item) => item.path).join(", ")}`);

    const tests = await execute("npm", ["test"], { cwd: candidate });
    await writeFile(join(output, "tests.log"), `${tests.stdout}\n${tests.stderr}`);
    const deterministicRoot = join(output, "deterministic");
    const deterministic = await execute("node", ["eval/run-daily-performance.mjs", "--suite", join(candidate, "benchmarks", "semantic-clean-v0.1", "frozen-v0.1"), "--output-root", deterministicRoot], { cwd: candidate });
    await writeFile(join(output, "deterministic.log"), `${deterministic.stdout}\n${deterministic.stderr}`);
    if (deterministic.code !== 0) throw new Error(`deterministic validation failed; see ${join(output, "deterministic.log")}`);
    const deterministicRun = await latest(deterministicRoot);
    const requireAi = actions.length > 0 && !has("--skip-ai");
    let aiCandidate = [];
    let aiRun = null;
    if (requireAi) {
      if (!aiBaseline) throw new Error("AI baseline is required for prompt validation");
      const aiRoot = join(output, "ai");
      const ai = await execute("node", ["eval/run-daily-ai-performance.mjs", "--suite", join(candidate, "benchmarks", "semantic-clean-v0.1", "frozen-v0.1"), "--output-root", aiRoot, "--model", value("--model", process.env.CODEX_MODEL || "gpt-5.6-sol"), "--codex-bin", value("--codex-bin", process.env.CODEX_BIN || "codex"), "--repeats", value("--repeats", "3"), "--concurrency", value("--concurrency", "4")], { cwd: candidate });
      await writeFile(join(output, "ai.log"), `${ai.stdout}\n${ai.stderr}`);
      if (ai.code !== 0) throw new Error(`AI validation failed; see ${join(output, "ai.log")}`);
      aiRun = await latest(aiRoot);
      aiCandidate = await readJsonl(join(aiRun, "predictions.jsonl"));
    }
    const gate = evaluateCandidateGate({
      goldRecords: gold,
      baselinePredictions: await readJsonl(join(deterministicBaseline, "predictions.jsonl")),
      candidatePredictions: await readJsonl(join(deterministicRun, "predictions.jsonl")),
      targetCaseIds: targetIds,
      testsPassed: tests.code === 0 && deterministic.code === 0,
      requireAi,
      aiBaselinePredictions: aiBaseline ? await readJsonl(join(aiBaseline, "predictions.jsonl")) : [],
      aiCandidatePredictions: aiCandidate,
    });
    const candidateFiles = join(output, "candidate-files");
    for (const change of changed) {
      if (change.deleted) continue;
      await mkdir(dirname(join(candidateFiles, change.path)), { recursive: true });
      await copyFile(join(candidate, change.path), join(candidateFiles, change.path));
    }
    const result = { schemaVersion: "improvement-execution-v0.1", runId, harness, model: value("--model", process.env.CODEX_MODEL || "gpt-5.6-sol"), actions: actions.map((action) => action.id), changed, gate, applied: false, publishedRuns: [] };
    if (has("--apply") && gate.passed) {
      for (const change of changed) {
        let current = null;
        try { current = await readFile(join(ROOT, change.path)); } catch { /* new */ }
        if ((current ? sha(current) : null) !== change.beforeSha256) throw new Error(`source changed during validation: ${change.path}`);
        if (change.deleted) await rm(join(ROOT, change.path));
        else { await mkdir(dirname(join(ROOT, change.path)), { recursive: true }); await copyFile(join(candidate, change.path), join(ROOT, change.path)); }
      }
      result.applied = true;
      const deterministicPublished = join(ROOT, ".cache", "performance-runs", "semantic-clean-v0.1", `${runId}-accepted`);
      await mkdir(dirname(deterministicPublished), { recursive: true });
      await cp(deterministicRun, deterministicPublished, { recursive: true });
      result.publishedRuns.push(deterministicPublished);
      if (aiRun) {
        const aiPublished = join(ROOT, ".cache", "performance-runs", "semantic-clean-v0.1-ai", `${runId}-accepted`);
        await mkdir(dirname(aiPublished), { recursive: true });
        await cp(aiRun, aiPublished, { recursive: true });
        result.publishedRuns.push(aiPublished);
      }
    }
    await writeFile(join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Candidate gate: ${gate.passed ? "PASSED" : "REJECTED"}`);
    console.log(`Changed files: ${changed.map((item) => item.path).join(", ")}`);
    console.log(`Applied: ${result.applied}`);
    console.log(`Saved: ${output}`);
    if (!gate.passed) process.exitCode = 3;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
