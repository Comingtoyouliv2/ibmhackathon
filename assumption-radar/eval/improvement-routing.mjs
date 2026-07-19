import { semanticOutcome, stableHash } from "./performance-utils.mjs";

function taskId(kind, identity) {
  return `${kind}-${stableHash(identity).slice(0, 12)}`;
}

function isAiPrediction(prediction) {
  return prediction.source === "codex"
    || prediction.source === "openai"
    || prediction.source === "anthropic"
    || /semantic-judgment|\bai\b/i.test(prediction.basis || "");
}

function targetFiles(rootCause = "") {
  if (rootCause.includes("remove-vs-reference")) return ["src/adapters/java.mjs", "src/analyzer.mjs"];
  if (rootCause.includes("behavioral-composition")) return ["src/adapters/java.mjs", "src/analyzer.mjs", "src/integrated.mjs"];
  if (rootCause.includes("composition-risk")) return ["src/analyzer.mjs", "src/integrated.mjs"];
  return ["src/analyzer.mjs", "src/integrated.mjs"];
}

export function routeFrozenFailures({ goldRecords, predictions, errorLedger = [] }) {
  const predictionById = new Map(predictions.map((record) => [record.id, record]));
  const ledgerById = new Map(errorLedger.map((record) => [record.id, record]));
  const result = { codeActions: [], promptActions: [], verificationActions: [], humanQuestions: [] };

  for (const gold of goldRecords) {
    if (gold.semanticBenchmarkEligibility === "excluded") continue;
    const prediction = predictionById.get(gold.id);
    if (!prediction) {
      result.humanQuestions.push({
        id: taskId("human", gold.id), kind: "missing-prediction", caseId: gold.id,
        question: `고정 문제 ${gold.id}의 prediction이 없습니다. 실행 실패를 먼저 조사할까요?`,
      });
      continue;
    }
    if (isAiPrediction(prediction) && prediction.repeatStable === false) {
      result.humanQuestions.push({
        id: taskId("human", `${gold.id}:ai-unstable`), kind: "unstable-ai-verdict", caseId: gold.id,
        question: `${gold.id}의 동일 CASE_JSON 반복 판정이 ${prediction.repeatVerdicts.join(" / ")}로 갈렸습니다. prompt 수정 전에 실행 검증 또는 사람 adjudication으로 최종 lane을 정할까요?`,
        context: { gold: gold.gold, prediction: prediction.prediction, repeatVerdicts: prediction.repeatVerdicts },
      });
      continue;
    }
    if (semanticOutcome(gold.gold, prediction.prediction)) continue;
    const ledger = ledgerById.get(gold.id);
    const common = {
      caseId: gold.id,
      gold: gold.gold,
      prediction: prediction.prediction,
      archetype: gold.archetype,
      rootCause: ledger?.rootCause || "unclassified-benchmark-error",
      recommendedExperiment: ledger?.recommendedExperiment || "Inspect both diffs, classify the failed pipeline stage, and add a positive plus counterexample test.",
      acceptance: [
        `Correct ${gold.id} on the same frozen input`,
        "Add at least one hard-negative or directional counterexample",
        "Do not introduce a new frozen-benchmark regression",
        "Run the full test suite",
      ],
    };

    if (!isAiPrediction(prediction)) {
      result.codeActions.push({
        id: taskId("code", gold.id), kind: "code-fix", status: "proposed", ...common,
        targetFiles: targetFiles(common.rootCause),
      });
      continue;
    }

    const repeats = prediction.repeatVerdicts || [];
    const stable = repeats.length >= 3 && new Set(repeats).size === 1;
    if (stable) {
      result.promptActions.push({
        id: taskId("prompt", gold.id), kind: "prompt-or-context-fix", status: "proposed", ...common,
        targetFiles: ["src/semantic-judge.mjs", "src/codex.mjs"],
        acceptance: [...common.acceptance, "Repeat the same CASE_JSON three times and report verdict stability"],
      });
    } else {
      result.humanQuestions.push({
        id: taskId("human", gold.id), kind: "unstable-or-unrepeated-ai-error", caseId: gold.id,
        question: `${gold.id}의 AI 판정이 gold와 다릅니다. 동일 CASE_JSON을 3회 재판정해 prompt 문제와 비결정성을 분리할까요?`,
        context: { gold: gold.gold, prediction: prediction.prediction, repeatVerdicts: repeats },
      });
    }
  }
  return result;
}

export function routeLiveDiff({ repository, snapshot, diff }) {
  const result = { codeActions: [], promptActions: [], verificationActions: [], humanQuestions: [] };
  const coordination = [];

  for (const finding of diff.new || []) {
    if (finding.verdict === "coordination") {
      coordination.push(finding);
      continue;
    }
    result.verificationActions.push({
      id: taskId("verify", finding.logicalKey), kind: "verify-new-live-warning", status: "proposed",
      repository, logicalKey: finding.logicalKey, prNumbers: finding.prNumbers,
      verdict: finding.verdict, basis: finding.basis, source: finding.source,
      inputFingerprint: finding.inputFingerprint,
      acceptance: [
        "Record immutable base and both PR head SHAs",
        "Run Base, A, B, and A+B in the same pinned environment",
        "Require Base/A/B to pass before classifying A+B",
        "Repeat an A+B failure and compare the failure signature",
      ],
    });
  }

  if (coordination.length) {
    result.humanQuestions.push({
      id: taskId("human", `${repository}:coordination`), kind: "coordination-policy", repository,
      question: `${repository}의 새 Git coordination ${coordination.length}쌍은 자동 semantic 검증 대상이 아닙니다. resolution branch를 만들어 양쪽 의도 보존 테스트를 진행할까요?`,
      pairs: coordination.map((finding) => finding.prNumbers),
    });
  }

  for (const change of diff.changed || []) {
    if (change.inputChanged) {
      result.verificationActions.push({
        id: taskId("verify", `${change.logicalKey}:changed-input`), kind: "verify-updated-live-warning", status: "proposed",
        repository, logicalKey: change.logicalKey, prNumbers: change.prNumbers,
        previous: change.previous, current: change.current,
        reason: "PR head/base input changed; treat this as a new case rather than a regression.",
      });
    } else if (["codex", "openai", "anthropic"].includes(change.current.source)) {
      result.humanQuestions.push({
        id: taskId("human", `${change.logicalKey}:ai-flip`), kind: "ai-verdict-flip", repository,
        question: `${change.logicalKey}의 입력 SHA는 같은데 AI verdict가 바뀌었습니다. 3회 반복 판정 후 unstable로 보낼까요?`,
        context: change,
      });
    } else {
      result.codeActions.push({
        id: taskId("code", `${change.logicalKey}:deterministic-change`), kind: "diagnose-deterministic-live-change", status: "proposed",
        repository, logicalKey: change.logicalKey, prNumbers: change.prNumbers,
        reason: "The same input produced a different deterministic finding; compare application commits and witness generation.",
        targetFiles: ["src/analyzer.mjs", "src/integrated.mjs", "src/pipeline.mjs"],
      });
    }
  }

  if ((diff.cleared || []).length) {
    result.humanQuestions.push({
      id: taskId("human", `${repository}:cleared`), kind: "cleared-warning-review", repository,
      question: `${repository}에서 ${diff.cleared.length}개 경고가 같은 PR 범위 안에서 사라졌습니다. 이전 경고가 confirmed였는지 확인한 뒤 회귀 여부를 판정할까요?`,
      pairs: diff.cleared.map((finding) => finding.prNumbers),
    });
  }
  return result;
}

export function mergeRoutes(routes) {
  const combined = routes.reduce((combined, route) => {
    for (const key of ["codeActions", "promptActions", "verificationActions", "humanQuestions"]) {
      combined[key].push(...(route[key] || []));
    }
    return combined;
  }, { codeActions: [], promptActions: [], verificationActions: [], humanQuestions: [] });
  for (const key of Object.keys(combined)) {
    combined[key] = [...new Map(combined[key].map((item) => [item.id, item])).values()];
  }
  return combined;
}
