import { semanticOutcome, compareFrozenPredictions, stableHash } from "./performance-utils.mjs";

const HUMAN_DECISIONS = new Set(["conflict", "harmless", "verify", "retry", "expected", "regression", "skip"]);

export function allowedHumanDecisions(question) {
  if (question.kind === "cleared-warning-review") return ["expected", "regression", "skip"];
  if (question.kind === "compatible-promotion-adjudication") return ["harmless", "conflict", "retry", "skip"];
  if (question.kind === "conflict-promotion-adjudication") return ["conflict", "retry", "skip"];
  if (["missing-prediction", "unstable-ai-verdict", "unstable-or-unrepeated-ai-error", "ai-verdict-flip", "coordination-policy"].includes(question.kind)) {
    return ["verify", "retry", "skip"];
  }
  return question.caseId ? ["conflict", "harmless", "retry", "skip"] : ["verify", "retry", "skip"];
}

export function buildHumanAnswerTemplate(questions) {
  return questions.map((question) => ({
    questionId: question.id,
    decision: null,
    note: "",
    question: question.question,
    allowedDecisions: allowedHumanDecisions(question),
  }));
}

export function resolveHumanAnswers(questions, answers) {
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]));
  const resolved = [];
  const pending = [];
  const errors = [];
  for (const question of questions) {
    const answer = byId.get(question.id);
    if (!answer || answer.decision === null || answer.decision === "") {
      pending.push(question);
      continue;
    }
    const allowed = allowedHumanDecisions(question);
    if (!HUMAN_DECISIONS.has(answer.decision) || !allowed.includes(answer.decision)) {
      errors.push(`${question.id}: unsupported decision '${answer.decision}' (allowed: ${allowed.join(", ")})`);
      continue;
    }
    resolved.push({ ...question, status: "resolved", decision: answer.decision, note: answer.note || "", resolvedAt: answer.resolvedAt || new Date().toISOString() });
  }
  return { resolved, pending, errors };
}

export function evaluateCandidateGate({
  goldRecords,
  baselinePredictions,
  candidatePredictions,
  targetCaseIds = [],
  testsPassed,
  aiBaselinePredictions = [],
  aiCandidatePredictions = [],
  requireAi = false,
}) {
  const deterministicComparison = compareFrozenPredictions(goldRecords, baselinePredictions, candidatePredictions);
  const goldById = new Map(goldRecords.map((record) => [record.id, record]));
  const currentById = new Map(candidatePredictions.map((record) => [record.id, record]));
  const unresolvedTargets = targetCaseIds.filter((id) => {
    const gold = goldById.get(id);
    const prediction = currentById.get(id);
    return !gold || !prediction || !semanticOutcome(gold.gold, prediction.prediction);
  });
  const reasons = [];
  if (!testsPassed) reasons.push("test-suite-failed");
  if (deterministicComparison.counts.regressed) reasons.push(`deterministic-regressions:${deterministicComparison.counts.regressed}`);
  if (deterministicComparison.counts.missing) reasons.push(`deterministic-missing:${deterministicComparison.counts.missing}`);
  const blockerRegressions = goldRecords.filter((gold) => gold.gold === "conflict")
    .filter((gold) => baselinePredictions.find((item) => item.id === gold.id)?.prediction === "conflict")
    .filter((gold) => currentById.get(gold.id)?.prediction !== "conflict")
    .map((gold) => gold.id);
  if (blockerRegressions.length) reasons.push(`blocker-regressions:${blockerRegressions.join(",")}`);
  if (unresolvedTargets.length) reasons.push(`targets-not-corrected:${unresolvedTargets.join(",")}`);

  let aiComparison = null;
  if (requireAi) {
    if (!aiCandidatePredictions.length) reasons.push("missing-ai-validation");
    else {
      aiComparison = compareFrozenPredictions(goldRecords, aiBaselinePredictions, aiCandidatePredictions);
      if (aiComparison.counts.regressed) reasons.push(`ai-regressions:${aiComparison.counts.regressed}`);
      if (aiComparison.counts.missing) reasons.push(`ai-missing:${aiComparison.counts.missing}`);
      const aiCandidateById = new Map(aiCandidatePredictions.map((record) => [record.id, record]));
      const aiBlockerRegressions = goldRecords.filter((gold) => gold.gold === "conflict")
        .filter((gold) => aiBaselinePredictions.find((item) => item.id === gold.id)?.prediction === "conflict")
        .filter((gold) => aiCandidateById.get(gold.id)?.prediction !== "conflict")
        .map((gold) => gold.id);
      if (aiBlockerRegressions.length) reasons.push(`ai-blocker-regressions:${aiBlockerRegressions.join(",")}`);
      const unstableBefore = aiBaselinePredictions.filter((item) => item.repeatStable === false).length;
      const unstableAfter = aiCandidatePredictions.filter((item) => item.repeatStable === false).length;
      if (unstableAfter > unstableBefore) reasons.push(`ai-instability-increased:${unstableBefore}->${unstableAfter}`);
    }
  }
  return {
    schemaVersion: "improvement-candidate-gate-v0.1",
    passed: reasons.length === 0,
    reasons,
    targetCaseIds,
    unresolvedTargets,
    blockerRegressions,
    deterministicComparison,
    aiComparison,
  };
}

export function buildPromotionCandidate({ repository, input, verification, finding, humanDecision = null }) {
  const verdict = verification?.classification?.verdict;
  if (!input?.prs?.length || !["conflict", "compatible"].includes(verdict)) return null;
  if (verdict === "compatible" && humanDecision !== "harmless") return null;
  if (verdict === "conflict" && humanDecision !== "conflict") return null;
  const gold = humanDecision;
  const id = `${repository}@live-${stableHash({ repository, baseSha: verification.baseSha, heads: [verification.headShaA, verification.headShaB] }).slice(0, 20)}`;
  return {
    input: { schemaVersion: "semantic-clean-input-v0.1", id, prs: input.prs },
    gold: {
      schemaVersion: "semantic-clean-gold-v0.1",
      id,
      repo: repository,
      language: "unknown",
      archetype: finding?.category || "live-verified",
      distance: "live-pr-pair",
      difficulty: "hard",
      gold,
      goldRelationship: gold === "conflict" ? "confirmed-conflict" : "compatible",
      goldRequiredAction: null,
      semanticBenchmarkEligibility: "included",
      mechanicalMerge: "clean",
      baseSha: verification.baseSha,
      parentShas: [verification.headShaA, verification.headShaB],
      observability: { mechanical: "merge-tree", semantic: "executable-base-a-b-combined" },
      evidenceGrade: "executable",
      rationale: verification.classification.rationale,
      source: { corpus: "Assumption Radar live verification", sourceLabel: "base-a-b-combined" },
      goldEvidence: (verification.classification.evidence || []).map((summary, index) => ({ id: `E${index + 1}`, kind: "execution", ref: verification.combinedTreeSha || "combined", summary })),
      adjudication: { status: "verified", date: verification.verifiedAt?.slice(0, 10), basis: ["immutable-shas", "base-a-b-combined", "repeated-failure-gate"] },
    },
  };
}

export function mergePromotions(existingInputs, existingGold, candidates) {
  const inputs = new Map(existingInputs.map((record) => [record.id, record]));
  const gold = new Map(existingGold.map((record) => [record.id, record]));
  let added = 0;
  for (const candidate of candidates.filter(Boolean)) {
    if (inputs.has(candidate.input.id) || gold.has(candidate.gold.id)) continue;
    inputs.set(candidate.input.id, candidate.input);
    gold.set(candidate.gold.id, candidate.gold);
    added += 1;
  }
  return { inputs: [...inputs.values()], gold: [...gold.values()], added };
}
