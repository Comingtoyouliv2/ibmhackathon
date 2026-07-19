import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSemanticJudgeCases,
  normalizeSemanticJudgments,
  selectSemanticJudgeCandidates,
  SEMANTIC_JUDGE_SYSTEM_PROMPT,
} from "./semantic-judge.mjs";

const judgmentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    prIds: { type: "array", minItems: 2, maxItems: 2, items: { type: "string" } },
    verdict: { type: "string", enum: ["conflict", "compatible", "uncertain", "coordination"] },
    category: { type: "string", enum: ["api", "data", "config", "auth", "event", "rollout", "behavior", "code"] },
    title: { type: "string" },
    summary: { type: "string" },
    assumptionA: { type: "string" },
    assumptionB: { type: "string" },
    failureMechanism: { type: "string" },
    recommendation: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          side: { type: "string", enum: ["A", "B"] },
          file: { type: "string" }, symbol: { type: "string" }, quote: { type: "string" },
        },
        required: ["side", "file", "symbol", "quote"],
      },
    },
  },
  required: ["prIds", "verdict", "category", "title", "summary", "assumptionA", "assumptionB", "failureMechanism", "recommendation", "confidence", "evidence"],
};

function promptFor(caseInput) {
  return [
    SEMANTIC_JUDGE_SYSTEM_PROMPT,
    "",
    "아래에는 단 하나의 PR pair만 있다. CASE_JSON 외의 저장소·웹·gold 정보는 사용하지 마라.",
    "conflict라면 A와 B 양쪽에서 CASE_JSON에 실제로 존재하는 quote를 최소 하나씩 반환하라.",
    "proximity나 일반적 위험 가능성만 있으면 uncertain이 아니라, 두 diff의 합집합이 유효한 근거가 보이면 compatible로 판정하라.",
    "특히 동일한 add-vs-add, 공통 helper 추출, 독립적인 기능 추가는 실제 cross-parent dependency가 없으면 compatible이다.",
    "출력은 지정된 JSON schema만 따른다.",
    "",
    `CASE_JSON=${JSON.stringify(caseInput)}`,
  ].join("\n");
}

export function runCodexJudgment({ prompt, model, codexBin = "codex", cwd, schemaPath, outputPath, reasoningEffort = "medium" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, [
      "exec", "-", "--model", model,
      "-c", `model_reasoning_effort=\"${reasoningEffort}\"`,
      "--ignore-user-config", "--ignore-rules", "--ephemeral",
      "--sandbox", "read-only", "--skip-git-repo-check", "--cd", cwd,
      "--output-schema", schemaPath, "--output-last-message", outputPath,
      "--color", "never",
    ], { cwd, env: process.env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_000); });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) return reject(new Error(`codex failed (${code})\n${stderr}`));
      try { resolve(JSON.parse(await readFile(outputPath, "utf8"))); }
      catch (error) { reject(error); }
    });
    child.stdin.end(prompt);
  });
}

async function defaultRunner(caseInput, options) {
  const work = await mkdtemp(join(tmpdir(), "assumption-radar-codex-"));
  const schemaPath = join(work, "output-schema.json");
  const outputPath = join(work, "judgment.json");
  await mkdir(work, { recursive: true });
  await writeFile(schemaPath, JSON.stringify(judgmentSchema));
  try {
    return await runCodexJudgment({
      prompt: promptFor(caseInput),
      model: options.model,
      codexBin: options.codexBin,
      cwd: work,
      schemaPath,
      outputPath,
      reasoningEffort: options.reasoningEffort,
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function analyzeWithCodex(prepared, options = {}) {
  const candidates = selectSemanticJudgeCandidates(prepared, options);
  if (!candidates.length) return [];
  const cases = buildSemanticJudgeCases(prepared, candidates, options);
  const settings = {
    model: options.model || process.env.CODEX_MODEL || "gpt-5.4",
    codexBin: options.codexBin || process.env.CODEX_BIN || "codex",
    reasoningEffort: options.reasoningEffort || "medium",
  };
  const runner = options.runner || ((caseInput) => defaultRunner(caseInput, settings));
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency || 4)));
  const rawJudgments = new Array(cases.length);
  let cursor = 0;
  async function worker() {
    while (cursor < cases.length) {
      const index = cursor++;
      rawJudgments[index] = await runner(cases[index], settings);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));
  return normalizeSemanticJudgments(prepared, candidates, rawJudgments, {
    source: "codex", basis: "codex-semantic-judgment-v0.2",
  });
}
