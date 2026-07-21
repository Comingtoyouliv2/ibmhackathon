import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateSemanticJudgmentRuns,
  buildSemanticJudgeCases,
  runRepeatedCaseJudgments,
  selectSemanticJudgeCandidates,
  SEMANTIC_JUDGE_SYSTEM_PROMPT,
} from "./semantic-judge.mjs";

const judgmentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    prIds: { type: "array", minItems: 2, maxItems: 2, items: { type: "string" } },
    assessment: { type: "string", enum: ["contract-backed-conflict", "testable-hypothesis", "no-plausible-interaction", "insufficient-evidence", "coordination-required"] },
    category: { type: "string", enum: ["api", "data", "config", "auth", "event", "rollout", "behavior", "code"] },
    title: { type: "string" },
    summary: { type: "string" },
    assumptionOwner: { type: "string", enum: ["PR-A", "PR-B", "both", "unknown"] },
    assumption: { type: "string" },
    violatingChange: { type: "string" },
    preconditions: { type: "array", items: { type: "string" } },
    triggerSequence: { type: "array", items: { type: "string" } },
    expectedBehavior: { type: "string" },
    possibleActualBehavior: { type: "string" },
    contract: {
      type: "object", additionalProperties: false,
      properties: {
        identity: { type: "string" }, kind: { type: "string" },
        providerSide: { type: "string", enum: ["PR-A", "PR-B", "unknown"] },
        consumerSide: { type: "string", enum: ["PR-A", "PR-B", "unknown"] },
        providerChange: { type: "string" }, consumerDependency: { type: "string" }, composedFailure: { type: "string" },
      },
      required: ["identity", "kind", "providerSide", "consumerSide", "providerChange", "consumerDependency", "composedFailure"],
    },
    testPlan: {
      type: "object", additionalProperties: false,
      properties: {
        name: { type: "string" },
        strategy: { type: "string", enum: ["existing-test", "targeted-test", "property-test", "fuzz", "trace-differential"] },
        setup: { type: "array", items: { type: "string" } },
        steps: { type: "array", items: { type: "string" } },
        oracle: { type: "string" },
        targetTests: { type: "array", items: { type: "string" } },
      },
      required: ["name", "strategy", "setup", "steps", "oracle", "targetTests"],
    },
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
  required: ["prIds", "assessment", "category", "title", "summary", "assumptionOwner", "assumption", "violatingChange", "preconditions", "triggerSequence", "expectedBehavior", "possibleActualBehavior", "contract", "testPlan", "confidence", "evidence"],
};

function promptFor(caseInput) {
  return [
    SEMANTIC_JUDGE_SYSTEM_PROMPT,
    "",
    "아래에는 단 하나의 PR pair만 있다. CASE_JSON 외의 저장소·웹·gold 정보는 사용하지 마라.",
    "양쪽 실제 코드가 provider 변경 → consumer 의존 → 합성 실패로 완결되면 contract-backed-conflict를 선택할 수 있다. 이는 실행 확정이 아니라 코드 계약 증거 등급이다.",
    "contract-backed-conflict 또는 testable-hypothesis라면 A와 B 양쪽에서 CASE_JSON에 실제로 존재하는 quote, 트리거 순서와 oracle을 반환하라.",
    "proximity나 일반적 위험 가능성만 있으면 insufficient-evidence, 행동 경로가 없으면 no-plausible-interaction을 선택하라.",
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
    reasoningEffort: options.reasoningEffort || process.env.CODEX_REASONING_EFFORT || "medium",
  };
  const runner = options.runner || ((caseInput) => defaultRunner(caseInput, settings));
  const protocolRuns = await runRepeatedCaseJudgments(cases, (caseInput) => runner(caseInput, settings), options);
  if (!protocolRuns.runs.some((run) => run.some((raw) => raw && !raw.protocolError))) {
    throw new Error("모든 Codex 반복 판정이 실패했습니다.");
  }
  return aggregateSemanticJudgmentRuns(prepared, candidates, protocolRuns, {
    ...options,
    source: "codex", basis: "codex-interaction-hypothesis-v0.5",
  });
}
