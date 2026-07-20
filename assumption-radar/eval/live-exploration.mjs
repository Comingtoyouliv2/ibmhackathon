import { stableHash } from "./performance-utils.mjs";

const STRATA = Object.freeze([
  "same-file-or-contract",
  "same-module",
  "weak-symbol-or-intent",
  "random-no-overlap",
]);

function stratumFor(comparison) {
  return STRATA[comparison.retrievalFeatures?.priority ?? 3] || STRATA[3];
}

function normalizedPair(repository, comparison, prsById) {
  const prs = comparison.prIds.map((id) => prsById.get(String(id))).filter(Boolean).sort((left, right) => left.number - right.number);
  if (prs.length !== 2 || prs.some((pr) => !pr.headSha)) return null;
  const input = prs.map((pr) => ({ number: pr.number, headSha: pr.headSha, base: pr.base, baseSha: pr.baseSha }));
  return {
    logicalKey: `${repository}#${prs.map((pr) => pr.number).join(":")}`,
    prNumbers: prs.map((pr) => pr.number),
    urls: prs.map((pr) => pr.url),
    verdict: "independent",
    predictedVerdict: "independent",
    basis: comparison.basis,
    source: comparison.source,
    samplingStratum: stratumFor(comparison),
    retrievalPriority: comparison.retrievalFeatures?.priority ?? 3,
    retrievalScore: comparison.retrievalScore || 0,
    retrievalReasons: comparison.retrievalReasons || [],
    inputFingerprint: stableHash(input),
  };
}

/**
 * Selects deterministic, stratified no-alert controls so live verification can
 * discover retrieval false negatives instead of validating alerts only.
 */
export function selectExplorationControls({ repository, comparisons = [], prs = [], findingKeys = [], stacks = [], limit = 4 }) {
  const boundedLimit = Math.max(0, Math.min(50, Number(limit) || 0));
  if (!boundedLimit) return [];
  const findings = new Set(findingKeys);
  const stackKeys = new Set(stacks.map((stack) => [stack.ancestorId, stack.descendantId].map(String).sort().join(":")));
  const prsById = new Map(prs.map((pr) => [String(pr.id), pr]));
  const buckets = new Map(STRATA.map((stratum) => [stratum, []]));
  for (const comparison of comparisons) {
    if (comparison.verdict !== "independent" || findings.has(comparison.key)
      || stackKeys.has(comparison.prIds.map(String).sort().join(":"))
      || comparison.semanticBenchmarkEligibility === "excluded"
      || ["conflict", "base-conflict", "textual-conflict"].includes(comparison.mechanicalMerge)) continue;
    const item = normalizedPair(repository, comparison, prsById);
    if (item) buckets.get(item.samplingStratum).push(item);
  }
  for (const [stratum, items] of buckets) {
    items.sort((left, right) => stratum === "random-no-overlap"
      ? stableHash(left.logicalKey).localeCompare(stableHash(right.logicalKey))
      : right.retrievalScore - left.retrievalScore || left.logicalKey.localeCompare(right.logicalKey));
  }
  const selected = [];
  while (selected.length < boundedLimit && [...buckets.values()].some((items) => items.length)) {
    for (const stratum of STRATA) {
      const item = buckets.get(stratum).shift();
      if (item) selected.push(item);
      if (selected.length >= boundedLimit) break;
    }
  }
  return selected;
}

export function buildLiveErrorLedger(results = []) {
  const records = [];
  for (const result of results) {
    const prediction = result.finding?.verdict || result.action?.predictedVerdict || null;
    const actual = result.verification?.classification?.verdict;
    if (!prediction || !["conflict", "compatible"].includes(actual)) continue;
    let errorType = null;
    let pipelineStage = null;
    let rootCause = null;
    let recommendedExperiment = null;
    if (actual === "conflict" && ["independent", "insufficient"].includes(prediction)) {
      errorType = "false-negative";
      pipelineStage = "candidate-retrieval";
      rootCause = result.action?.exploration
        ? `missed-no-alert-${result.action.samplingStratum || "control"}`
        : "missed-live-conflict";
      recommendedExperiment = "Inspect both diffs and the repeated A+B failure, identify the missing cross-PR dependency, then add one positive and one hard-negative regression test.";
    } else if (actual === "compatible" && ["conflict", "review"].includes(prediction)) {
      errorType = "false-positive-candidate";
      pipelineStage = "semantic-judgment";
      rootCause = "warning-without-observed-pair-regression";
      recommendedExperiment = "Human-check test coverage before treating this as harmless, then narrow the witness only if the pair is adjudicated compatible.";
    }
    if (!errorType) continue;
    records.push({
      schemaVersion: "live-error-ledger-v0.1",
      id: result.finding?.logicalKey || result.action?.logicalKey,
      repository: result.repository,
      errorType,
      prediction,
      executionOutcome: actual,
      pipelineStage,
      rootCause,
      samplingStratum: result.action?.samplingStratum || null,
      immutableInput: {
        baseSha: result.verification.baseSha,
        headShaA: result.verification.headShaA,
        headShaB: result.verification.headShaB,
      },
      failureEvidence: result.verification.classification.evidence || [],
      recommendedExperiment,
      observedAt: result.verification.verifiedAt,
    });
  }
  return records;
}
