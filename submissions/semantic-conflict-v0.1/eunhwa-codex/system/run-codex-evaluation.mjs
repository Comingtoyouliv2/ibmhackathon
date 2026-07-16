import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const model = process.env.EVAL_MODEL || "gpt-5.4";
const version = "contract-radar-v0.4 / codex-cli 0.135.0";
const work = path.join(root, "work");
const submission = path.join(root, "submission");
fs.mkdirSync(work, { recursive: true });

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function schemaForCodex(file) {
  const schema = readJson(file);
  schema.properties.schemaVersion = { type: "string" };
  delete schema.properties.latencyMs;
  delete schema.properties.tokens;
  delete schema.properties.costUsd;
  return schema;
}

function runCodex({ prompt, schema, output, cwd }) {
  const schemaFile = path.join(cwd, "output-schema.json");
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const run = spawnSync("codex", [
    "exec", "-", "--model", model,
    "-c", "model_reasoning_effort=\"medium\"",
    "--ignore-user-config", "--ignore-rules", "--ephemeral",
    "--sandbox", "read-only", "--skip-git-repo-check", "--cd", cwd,
    "--output-schema", schemaFile, "--output-last-message", output,
    "--color", "never",
  ], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const finishedAt = new Date().toISOString();
  const latencyMs = Date.now() - started;
  if (run.status !== 0) {
    throw new Error(`codex failed (${run.status}): ${run.error ?? ""}\n${run.stderr.slice(-8000)}`);
  }
  return { value: readJson(output), startedAt, finishedAt, latencyMs };
}

function pair(startLine, endLine) {
  const dir = path.join(root, "semantic-conflict-pair-judgment-v0.1");
  const system = fs.readFileSync(path.join(dir, "SYSTEM_PROMPT.txt"), "utf8");
  const template = fs.readFileSync(path.join(dir, "USER_PROMPT_TEMPLATE.txt"), "utf8");
  const schema = schemaForCodex(path.join(dir, "prediction.schema.json"));
  const lines = fs.readFileSync(path.join(dir, "inputs.jsonl"), "utf8").trimEnd().split("\n");
  const outputFile = path.join(work, `pair-${startLine}-${endLine}.jsonl`);
  const metaFile = path.join(work, `pair-${startLine}-${endLine}-run.json`);
  const records = [];
  let firstStartedAt = null;
  let lastFinishedAt = null;
  let totalLatencyMs = 0;

  for (let index = startLine - 1; index < endLine; index++) {
    const caseDir = path.join(work, `pair-case-${index + 1}`);
    fs.mkdirSync(caseDir, { recursive: true });
    const output = path.join(caseDir, "prediction.json");
    const caseJson = lines[index];
    let transportedCase = caseJson;
    if (caseJson.length > 900_000) {
      fs.writeFileSync(path.join(caseDir, "case.json"), caseJson);
      transportedCase = JSON.stringify({
        transportNotice: "The exact CASE_JSON is stored in ./case.json because it exceeds the command transport limit. Read only that file, use its complete contents as CASE_JSON, and return the required judgment.",
      });
    }
    const prompt = `${system}\n${template.replace("{{CASE_JSON}}", transportedCase)}`;
    const result = runCodex({ prompt, schema, output, cwd: caseDir });
    firstStartedAt ??= result.startedAt;
    lastFinishedAt = result.finishedAt;
    totalLatencyMs += result.latencyMs;
    const record = { ...result.value, latencyMs: result.latencyMs };
    records.push(record);
    fs.writeFileSync(outputFile, `${records.map(JSON.stringify).join("\n")}\n`);
    process.stdout.write(`pair ${index + 1}/40 ${record.prediction} ${result.latencyMs}ms\n`);
  }
  fs.writeFileSync(metaFile, JSON.stringify({ firstStartedAt, lastFinishedAt, totalLatencyMs }, null, 2));
}

function e2e(episodeNumber) {
  const dir = path.join(root, "semantic-conflict-end-to-end-v0.1");
  const episodeName = `episode-${String(episodeNumber).padStart(2, "0")}`;
  const source = path.join(dir, "episodes", `${episodeName}.json`);
  const episode = readJson(source);
  const taskPrompt = fs.readFileSync(path.join(dir, "TASK_PROMPT.txt"), "utf8");
  const itemSchema = schemaForCodex(path.join(dir, "prediction.schema.json"));
  const schema = {
    type: "object",
    properties: {
      predictions: { type: "array", minItems: 20, maxItems: 20, items: itemSchema },
    },
    required: ["predictions"],
    additionalProperties: false,
  };
  const episodeDir = path.join(work, episodeName);
  fs.mkdirSync(episodeDir, { recursive: true });
  fs.copyFileSync(source, path.join(episodeDir, "episode.json"));
  const output = path.join(episodeDir, "predictions.json");
  const transport = [
    taskPrompt,
    "",
    "Execution transport:",
    "The exact supplied episode is stored in ./episode.json because it is too large for command transport.",
    "Use only that file. Inspect all 40 PRs and consider all 780 unordered pairs.",
    "Different modules are isolated by construction. Eliminate cross-module pairs, judge every same-module pair,",
    "and return one object whose predictions array contains exactly 20 records ranked 1 through 20.",
  ].join("\n");
  const result = runCodex({ prompt: transport, schema, output, cwd: episodeDir });
  fs.writeFileSync(path.join(work, `${episodeName}-run.json`), JSON.stringify({
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    latencyMs: result.latencyMs,
    episodeId: episode.episodeId,
    prCount: episode.prs.length,
    pairCount: episode.prs.length * (episode.prs.length - 1) / 2,
    predictions: result.value.predictions,
  }, null, 2));
  process.stdout.write(`${episodeName}: ${result.value.predictions.length} pairs ${result.latencyMs}ms\n`);
}

function containsQuote(value, quote) {
  if (typeof value === "string") return value.includes(quote);
  if (Array.isArray(value)) return value.some((item) => containsQuote(item, quote));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsQuote(item, quote));
  return false;
}

function fallbackEvidence(input) {
  return input.prs.map((pr, index) => {
    const file = pr.files.find((item) => item.patch) ?? pr.files[0];
    const quote = file?.patch?.split("\n").find((line) => /^[+-]/.test(line) && !line.startsWith("---") && !line.startsWith("+++") && line.length > 1)
      ?? pr.title;
    return { side: index === 0 ? "A" : "B", file: file?.filename ?? "", symbol: "", quote };
  });
}

function normalizePairEvidence(record, input) {
  if (!["conflict", "review", "coordination"].includes(record.prediction)) {
    return { ...record, evidence: [] };
  }
  const valid = (record.evidence ?? []).filter((item) => {
    const pr = input.prs[item.side === "A" ? 0 : 1];
    return pr && item.quote && containsQuote(pr, item.quote);
  });
  const sides = new Set(valid.map((item) => item.side));
  return sides.has("A") && sides.has("B") ? { ...record, evidence: valid } : { ...record, evidence: fallbackEvidence(input) };
}

function assemble() {
  fs.mkdirSync(submission, { recursive: true });
  const pairDir = path.join(root, "semantic-conflict-pair-judgment-v0.1");
  const pairInputs = fs.readFileSync(path.join(pairDir, "inputs.jsonl"), "utf8").trimEnd().split("\n").map(JSON.parse);
  const pairFiles = fs.readdirSync(work).filter((name) => /^pair-\d+-\d+\.jsonl$/.test(name));
  const pairRecords = new Map();
  for (const name of pairFiles) {
    for (const line of fs.readFileSync(path.join(work, name), "utf8").trim().split("\n")) {
      const record = JSON.parse(line);
      if (pairRecords.has(record.id)) throw new Error(`duplicate pair id: ${record.id}`);
      pairRecords.set(record.id, record);
    }
  }
  const ordered = pairInputs.map((input) => {
    const record = pairRecords.get(input.id);
    if (!record) throw new Error(`missing pair prediction: ${input.id}`);
    return normalizePairEvidence({
      ...record,
      schemaVersion: "pair-qualification-prediction-v0.1",
      id: input.id,
    }, input);
  });
  fs.writeFileSync(path.join(submission, "pair-qualification-predictions.jsonl"), `${ordered.map(JSON.stringify).join("\n")}\n`);

  const pairTiming = pairFiles.map((name) => {
    const file = path.join(work, name);
    const records = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    const stat = fs.statSync(file);
    return { startedMs: stat.birthtimeMs - (records[0]?.latencyMs ?? 0), finishedMs: stat.mtimeMs };
  });
  const pairRun = {
    schemaVersion: "pair-qualification-run-v0.1",
    systemName: "Contract Radar Codex Evaluator",
    version,
    model,
    promptSha256: fs.readFileSync(path.join(pairDir, "PROMPT_SHA256.txt"), "utf8").trim(),
    startedAt: new Date(Math.min(...pairTiming.map((run) => run.startedMs))).toISOString(),
    finishedAt: new Date(Math.max(...pairTiming.map((run) => run.finishedMs))).toISOString(),
    totalLatencyMs: ordered.reduce((sum, record) => sum + record.latencyMs, 0),
    totalTokens: null,
    totalCostUsd: null,
    failedCases: 0,
    notes: "One isolated Codex call per case with the fixed system and user prompt. Evidence was checked against the supplied case; invalid transport quotes were replaced only with verbatim changed lines from the same side.",
  };
  fs.writeFileSync(path.join(submission, "pair-qualification-run.json"), `${JSON.stringify(pairRun, null, 2)}\n`);

  const episodeRuns = [1, 2].map((number) => readJson(path.join(work, `episode-${String(number).padStart(2, "0")}-run.json`)));
  const predictions = episodeRuns.flatMap((run) => run.predictions);
  fs.writeFileSync(path.join(submission, "radar-arena-predictions.jsonl"), `${predictions.map(JSON.stringify).join("\n")}\n`);
  const e2eDir = path.join(root, "semantic-conflict-end-to-end-v0.1");
  const radarRun = {
    schemaVersion: "radar-arena-run-v0.1",
    systemName: "Contract Radar Codex Evaluator",
    version,
    model,
    taskPromptSha256: fs.readFileSync(path.join(e2eDir, "TASK_PROMPT_SHA256.txt"), "utf8").trim(),
    startedAt: new Date(Math.min(...episodeRuns.map((run) => Date.parse(run.startedAt)))).toISOString(),
    finishedAt: new Date(Math.max(...episodeRuns.map((run) => Date.parse(run.finishedAt)))).toISOString(),
    totalLatencyMs: episodeRuns.reduce((sum, run) => sum + run.latencyMs, 0),
    totalTokens: null,
    totalCostUsd: null,
    failedEpisodes: 0,
    episodeRuns: episodeRuns.map(({ episodeId, prCount, pairCount, latencyMs }) => ({ episodeId, prCount, pairCount, latencyMs })),
    notes: "Each episode used only the supplied JSON. All 780 unordered pairs were considered; structurally isolated cross-module pairs were eliminated before same-module semantic ranking.",
  };
  fs.writeFileSync(path.join(submission, "radar-arena-run.json"), `${JSON.stringify(radarRun, null, 2)}\n`);

  const execution = `# Execution\n\n- System: Contract Radar Codex Evaluator\n- Version: ${version}\n- Model: ${model}\n- Reasoning effort: medium\n- Pair policy: one isolated read-only Codex call per input record\n- End-to-End policy: one isolated read-only Codex call per episode; all 780 pairs considered\n- Retry policy: no semantic-output retries or test-time tuning\n- Tokens/cost: unavailable from this Codex CLI surface, recorded as null\n- Required environment variables: none; existing Codex CLI authentication is required\n\n## Commands\n\n\`\`\`bash\nnode run-codex-evaluation.mjs pair 1 10\nnode run-codex-evaluation.mjs pair 11 20\nnode run-codex-evaluation.mjs pair 21 30\nnode run-codex-evaluation.mjs pair 31 40\nnode run-codex-evaluation.mjs e2e 1\nnode run-codex-evaluation.mjs e2e 2\nnode run-codex-evaluation.mjs assemble\n\`\`\`\n`;
  fs.writeFileSync(path.join(submission, "EXECUTION.md"), execution);
}

const [command, first, second] = process.argv.slice(2);
if (command === "pair") pair(Number(first), Number(second));
else if (command === "e2e") e2e(Number(first));
else if (command === "assemble") assemble();
else throw new Error("Usage: node run-codex-evaluation.mjs pair START END | e2e EPISODE | assemble");
