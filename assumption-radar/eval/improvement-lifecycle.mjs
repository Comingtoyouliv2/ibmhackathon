import { semanticOutcome, compareFrozenPredictions, stableHash } from "./performance-utils.mjs";

const HUMAN_DECISIONS = new Set(["conflict", "harmless", "verify", "retry", "expected", "regression", "skip"]);

export function buildHumanAnswerTemplate(questions) {
  return questions.map((question) => ({
    questionId: question.id,
    decision: null,
    note: "",
    question: question.question,
    allowedDecisions: question.caseId
      ? ["conflict", "harmless", "retry", "skip"]
      : question.kind === "cleared-warning-review"
        ? ["expected", "regression", "skip"]
        : ["verify", "retry", "skip"],
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
    if (!HUMAN_DECISIONS.has(answer.decision)) {
      errors.push(`${question.id}: unsupported decision '${answer.decision}'`);
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
  if (unresolvedTargets.length) reasons.push(`targets-not-corrected:${unresolvedTargets.join(",")}`);

  let aiComparison = null;
  if (requireAi) {
    if (!aiCandidatePredictions.length) reasons.push("missing-ai-validation");
    else {
      aiComparison = compareFrozenPredictions(goldRecords, aiBaselinePredictions, aiCandidatePredictions);
      if (aiComparison.counts.regressed) reasons.push(`ai-regressions:${aiComparison.counts.regressed}`);
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
    deterministicComparison,
    aiComparison,
  };
}

export function buildPromotionCandidate({ repository, input, verification, finding, humanDecision = null }) {
  const verdict = verification?.classification?.verdict;
  if (!input?.prs?.length || !["conflict", "compatible"].includes(verdict)) return null;
  if (humanDecision && !["conflict", "harmless"].includes(humanDecision)) return null;
  if (verdict === "compatible" && humanDecision !== "harmless") return null;
  if (verdict === "conflict" && humanDecision === "harmless") return null;
  const gold = humanDecision || (verdict === "conflict" ? "conflict" : "harmless");
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
