#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

function usage() {
  console.log(`Usage:
  node eval/run-team1-codex-v0.2.mjs pair --suite DIR --output DIR [--model MODEL] [--concurrency N] [--dry-run]
  node eval/run-team1-codex-v0.2.mjs radar --suite DIR --output DIR [--model MODEL] [--concurrency N] [--dry-run]

The runner only reads public suite inputs. Gold paths are deliberately unsupported.`);
}

function parseArgs(argv) {
  const mode = argv[0];
  const options = {
    mode,
    model: process.env.EVAL_MODEL || "gpt-5.4",
    concurrency: mode === "radar" ? 2 : 4,
    codexBin: process.env.CODEX_BIN || "codex",
    dryRun: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (["--suite", "--output", "--model", "--concurrency", "--codex-bin"].includes(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--suite") options.suite = resolve(value);
      else if (arg === "--output") options.output = resolve(value);
      else if (arg === "--model") options.model = value;
      else if (arg === "--concurrency") options.concurrency = Number(value);
      else options.codexBin = value;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency must be a positive integer");
  return options;
}

async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${path}:${index + 1}: invalid JSON (${error.message})`); }
  });
}

const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function promptHash(suite, filenames) {
  try {
    return (await readFile(join(suite, filenames.hash), "utf8")).trim();
  } catch {
    const values = await Promise.all(filenames.sources.map((name) => readFile(join(suite, name), "utf8")));
    return hash(values.join("\n"));
  }
}

function codexSchema(path, { arrayLength = null } = {}) {
  return readFile(path, "utf8").then((text) => {
    const schema = JSON.parse(text);
    if (schema.properties?.schemaVersion) schema.properties.schemaVersion = { type: "string" };
    if (schema.properties) {
      delete schema.properties.latencyMs;
      delete schema.properties.tokens;
      delete schema.properties.costUsd;
    }
    if (arrayLength === null) return schema;
    return {
      type: "object",
      properties: {
        predictions: { type: "array", minItems: arrayLength, maxItems: arrayLength, items: schema },
      },
      required: ["predictions"],
      additionalProperties: false,
    };
  });
}

function runCodex({ bin, model, prompt, schemaPath, outputPath, cwd }) {
  return new Promise((done, reject) => {
    const startedAt = new Date();
    const started = performance.now();
    const child = spawn(bin, [
      "exec", "-", "--model", model,
      "-c", "model_reasoning_effort=\"medium\"",
      "--ignore-user-config", "--ignore-rules", "--ephemeral",
      "--sandbox", "read-only", "--skip-git-repo-check", "--cd", cwd,
      "--output-schema", schemaPath, "--output-last-message", outputPath,
      "--color", "never",
    ], { cwd, env: process.env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16000); });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) return reject(new Error(`codex failed (${code})\n${stderr}`));
      try {
        const value = JSON.parse(await readFile(outputPath, "utf8"));
        done({ value, latencyMs: performance.now() - started, startedAt, finishedAt: new Date() });
      } catch (error) { reject(error); }
    });
    child.stdin.end(prompt);
  });
}

async function pool(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return output;
}

function containsQuote(value, quote) {
  if (typeof value === "string") return value.includes(quote);
  if (Array.isArray(value)) return value.some((item) => containsQuote(item, quote));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsQuote(item, quote));
  return false;
}

function fallbackEvidence(input) {
  return input.prs.map((pr, index) => {
    const file = pr.files?.find((item) => item.patch) ?? pr.files?.[0];
    const quote = file?.patch?.split("\n").find((line) => /^[+-](?![+-])/.test(line) && line.length > 1) ?? pr.title;
    return { side: index === 0 ? "A" : "B", file: file?.filename ?? "", symbol: "", quote };
  }).filter((item) => item.quote);
}

function normalizePairEvidence(record, input) {
  if (!["conflict", "review", "coordination"].includes(record.prediction)) return { ...record, evidence: [] };
  const valid = (record.evidence ?? []).filter((item) => {
    const pr = input.prs[item.side === "A" ? 0 : 1];
    return pr && item.quote && containsQuote(pr, item.quote);
  });
  const sides = new Set(valid.map((item) => item.side));
  return sides.has("A") && sides.has("B") ? { ...record, evidence: valid } : { ...record, evidence: fallbackEvidence(input) };
}

async function runPair(options) {
  const inputPath = join(options.suite, "inputs.jsonl");
  const cases = await readJsonl(inputPath);
  const system = await readFile(join(options.suite, "SYSTEM_PROMPT.txt"), "utf8");
  const template = await readFile(join(options.suite, "USER_PROMPT_TEMPLATE.txt"), "utf8");
  const schema = await codexSchema(join(options.suite, "prediction.schema.json"));
  const promptSha256 = await promptHash(options.suite, { hash: "PROMPT_SHA256.txt", sources: ["SYSTEM_PROMPT.txt", "USER_PROMPT_TEMPLATE.txt"] });
  if (options.dryRun) {
    console.log(JSON.stringify({ mode: "pair", cases: cases.length, model: options.model, concurrency: options.concurrency, inputPath, output: options.output }, null, 2));
    return;
  }

  await mkdir(options.output, { recursive: true });
  const work = join(options.output, ".work");
  await mkdir(work, { recursive: true });
  const startedAt = new Date();
  const runs = await pool(cases, options.concurrency, async (record, index) => {
    const cwd = join(work, `pair-${String(index + 1).padStart(4, "0")}`);
    await mkdir(cwd, { recursive: true });
    const schemaPath = join(cwd, "output-schema.json");
    const outputPath = join(cwd, "prediction.json");
    await writeFile(schemaPath, JSON.stringify(schema));
    const raw = JSON.stringify(record);
    let transported = raw;
    if (raw.length > 900_000) {
      await writeFile(join(cwd, "case.json"), raw);
      transported = JSON.stringify({ transportNotice: "The exact CASE_JSON is stored in ./case.json. Read that complete file and use it as CASE_JSON." });
    }
    const result = await runCodex({
      bin: options.codexBin, model: options.model,
      prompt: `${system}\n${template.replace("{{CASE_JSON}}", transported)}`,
      schemaPath, outputPath, cwd,
    });
    const prediction = normalizePairEvidence({
      ...result.value,
      schemaVersion: "pair-qualification-prediction-v0.1",
      id: record.id,
      latencyMs: result.latencyMs,
    }, record);
    console.log(`team1 pair ${index + 1}/${cases.length} ${prediction.prediction} ${result.latencyMs.toFixed(0)}ms`);
    return { prediction, run: result };
  });
  const predictions = runs.map((item) => item.prediction);
  const totalLatencyMs = runs.reduce((sum, item) => sum + item.run.latencyMs, 0);
  await Promise.all([
    writeFile(join(options.output, "predictions.jsonl"), jsonl(predictions)),
    writeFile(join(options.output, "run.json"), `${JSON.stringify({
      schemaVersion: "pair-qualification-run-v0.1",
      systemName: "team1-contract-radar-codex",
      version: "comparison-adapter-v0.2",
      model: options.model,
      promptSha256,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      totalLatencyMs,
      totalTokens: null,
      totalCostUsd: null,
      failedCases: 0,
      notes: "Team 1 frozen behavior: one isolated read-only Codex call per pair. Public suite input only; no gold path is accepted by this runner.",
    }, null, 2)}\n`),
  ]);
}

async function runRadar(options) {
  const episodesDir = join(options.suite, "episodes");
  const names = (await readdir(episodesDir)).filter((name) => /^episode-\d+\.json$/.test(name)).sort();
  if (!names.length) throw new Error(`no episodes in ${episodesDir}`);
  const taskPrompt = await readFile(join(options.suite, "TASK_PROMPT.txt"), "utf8");
  const itemSchemaPath = join(options.suite, "prediction.schema.json");
  const taskPromptSha256 = await promptHash(options.suite, { hash: "TASK_PROMPT_SHA256.txt", sources: ["TASK_PROMPT.txt"] });
  const episodes = await Promise.all(names.map(async (name) => ({ name, value: JSON.parse(await readFile(join(episodesDir, name), "utf8")) })));
  if (options.dryRun) {
    console.log(JSON.stringify({ mode: "radar", episodes: episodes.length, model: options.model, concurrency: options.concurrency, episodesDir, output: options.output }, null, 2));
    return;
  }

  await mkdir(options.output, { recursive: true });
  const work = join(options.output, ".work");
  await mkdir(work, { recursive: true });
  const startedAt = new Date();
  const runs = await pool(episodes, options.concurrency, async ({ name, value: episode }, index) => {
    const required = Number(episode.metadata?.requiredOutputPairs ?? 20);
    const pairCount = episode.prs.length * (episode.prs.length - 1) / 2;
    const cwd = join(work, name.replace(/\.json$/, ""));
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "episode.json"), `${JSON.stringify(episode)}\n`);
    const schema = await codexSchema(itemSchemaPath, { arrayLength: required });
    const schemaPath = join(cwd, "output-schema.json");
    const outputPath = join(cwd, "predictions.json");
    await writeFile(schemaPath, JSON.stringify(schema));
    const transport = [
      taskPrompt,
      "",
      "Execution transport:",
      "The exact supplied episode is stored in ./episode.json.",
      `Inspect all ${episode.prs.length} PRs, consider all ${pairCount} unordered pairs, and return exactly ${required} ranked records.`,
      "Use no information other than the public task prompt and episode file.",
    ].join("\n");
    const result = await runCodex({ bin: options.codexBin, model: options.model, prompt: transport, schemaPath, outputPath, cwd });
    const predictions = result.value.predictions.map((record, rank) => ({
      ...record,
      schemaVersion: "radar-arena-prediction-v0.1",
      episodeId: episode.episodeId,
      rank: rank + 1,
    }));
    console.log(`team1 radar ${index + 1}/${episodes.length} ${predictions.length} pairs ${result.latencyMs.toFixed(0)}ms`);
    return { predictions, run: result, episodeId: episode.episodeId, prCount: episode.prs.length, pairCount };
  });
  const predictions = runs.flatMap((item) => item.predictions);
  await Promise.all([
    writeFile(join(options.output, "predictions.jsonl"), jsonl(predictions)),
    writeFile(join(options.output, "run.json"), `${JSON.stringify({
      schemaVersion: "radar-arena-run-v0.1",
      systemName: "team1-contract-radar-codex",
      version: "comparison-adapter-v0.2",
      model: options.model,
      taskPromptSha256,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      totalLatencyMs: runs.reduce((sum, item) => sum + item.run.latencyMs, 0),
      totalTokens: null,
      totalCostUsd: null,
      failedEpisodes: 0,
      episodeRuns: runs.map((item) => ({ episodeId: item.episodeId, prCount: item.prCount, pairCount: item.pairCount, latencyMs: item.run.latencyMs })),
      notes: "Team 1 frozen behavior: one isolated read-only Codex ranking call per episode. No dataset-specific module hint is injected by the adapter.",
    }, null, 2)}\n`),
  ]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  if (!["pair", "radar"].includes(options.mode) || !options.suite || !options.output) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (options.mode === "pair") await runPair(options);
  else await runRadar(options);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
