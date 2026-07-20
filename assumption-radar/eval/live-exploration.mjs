import { stableHash } from "./performance-utils.mjs";

const STRATA = Object.freeze([
  "same-file-or-contract",
  "same-module",
  "weak-symbol-or-intent",
  "random-no-overlap",
]);

const DEFAULT_POLICY = Object.freeze({
  pairLimit: 200,
  timeBudgetMs: 2 * 60 * 60 * 1_000,
  pilotLimit: 4,
  budgetedLimit: 20,
});

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

function stackKeys(stacks) {
  return new Set(stacks.map((stack) => [stack.ancestorId, stack.descendantId].map(String).sort().join(":")));
}

function isExecutablePair(comparison, knownStackKeys) {
  return !knownStackKeys.has(comparison.prIds.map(String).sort().join(":"))
    && comparison.semanticBenchmarkEligibility !== "excluded"
    && !["conflict", "base-conflict", "textual-conflict"].includes(comparison.mechanicalMerge);
}

function explorationBuckets({ repository, comparisons, prs, findingKeys, stacks }) {
  const findings = new Set(findingKeys);
  const knownStackKeys = stackKeys(stacks);
  const prsById = new Map(prs.map((pr) => [String(pr.id), pr]));
  const buckets = new Map(STRATA.map((stratum) => [stratum, []]));
  for (const comparison of comparisons) {
    if (comparison.verdict !== "independent" || findings.has(comparison.key) || !isExecutablePair(comparison, knownStackKeys)) continue;
    const item = normalizedPair(repository, comparison, prsById);
    if (item) buckets.get(item.samplingStratum).push(item);
  }
  for (const [stratum, items] of buckets) {
    items.sort((left, right) => stratum === "random-no-overlap"
      ? stableHash(left.logicalKey).localeCompare(stableHash(right.logicalKey))
      : right.retrievalScore - left.retrievalScore || left.logicalKey.localeCompare(right.logicalKey));
  }
  return buckets;
}

function roundRobin(buckets, limit) {
  const selected = [];
  while (selected.length < limit && [...buckets.values()].some((items) => items.length)) {
    for (const stratum of STRATA) {
      const item = buckets.get(stratum).shift();
      if (item) selected.push(item);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

function take(items, count, selected) {
  while (items.length && count > 0) {
    selected.push(items.shift());
    count -= 1;
  }
}

function weightedBudget(buckets, limit, existingRisk = 0) {
  const selected = [];
  const riskTarget = Math.ceil(limit * 0.7);
  const uncertaintyTarget = Math.min(limit - riskTarget, Math.ceil(limit * 0.2));
  const randomTarget = Math.max(0, limit - riskTarget - uncertaintyTarget);
  const remainingRisk = Math.max(0, riskTarget - existingRisk);
  const firstRisk = Math.ceil(remainingRisk * 0.6);
  take(buckets.get("same-file-or-contract"), firstRisk, selected);
  take(buckets.get("same-module"), remainingRisk - selected.length, selected);
  if (selected.length < remainingRisk) take(buckets.get("same-file-or-contract"), remainingRisk - selected.length, selected);
  take(buckets.get("weak-symbol-or-intent"), uncertaintyTarget, selected);
  take(buckets.get("random-no-overlap"), randomTarget, selected);
  if (selected.length < limit) selected.push(...roundRobin(buckets, limit - selected.length));
  return selected.slice(0, limit);
}

function median(values) {
  const ordered = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : Math.round((ordered[middle - 1] + ordered[middle]) / 2);
}

/**
 * Selects deterministic, stratified no-alert controls so live verification can
 * discover retrieval false negatives instead of validating alerts only.
 */
export function selectExplorationControls({ repository, comparisons = [], prs = [], findingKeys = [], stacks = [], limit = 4 }) {
  const boundedLimit = Math.max(0, Math.min(5_000, Number(limit) || 0));
  if (!boundedLimit) return [];
  return roundRobin(explorationBuckets({ repository, comparisons, prs, findingKeys, stacks }), boundedLimit);
}

/** Chooses full execution only when both pair count and measured time fit the budget. */
export function planLiveVerification({
  repository,
  comparisons = [],
  prs = [],
  findingKeys = [],
  stacks = [],
  executionProfile = null,
  mode = "auto",
  pairLimit = DEFAULT_POLICY.pairLimit,
  timeBudgetMs = DEFAULT_POLICY.timeBudgetMs,
  pilotLimit = DEFAULT_POLICY.pilotLimit,
  budgetedLimit = DEFAULT_POLICY.budgetedLimit,
  controlLimitOverride = null,
}) {
  const knownStackKeys = stackKeys(stacks);
  const prsById = new Map(prs.map((pr) => [String(pr.id), pr]));
  const findings = new Set(findingKeys);
  const eligible = comparisons.filter((comparison) => isExecutablePair(comparison, knownStackKeys)
    && normalizedPair(repository, comparison, prsById));
  const alerts = eligible.filter((comparison) => findings.has(comparison.key))
    .map((comparison) => normalizedPair(repository, comparison, prsById));
  const buckets = explorationBuckets({ repository, comparisons, prs, findingKeys, stacks });
  const noAlertCount = [...buckets.values()].reduce((total, items) => total + items.length, 0);
  const measured = Number(executionProfile?.medianCombinedMs) > 0;
  const estimatedTotalMs = measured
    ? Math.round((Number(executionProfile.medianBaseMs) || 0)
      + prs.length * (Number(executionProfile.medianSingleMs) || 0)
      + eligible.length * Number(executionProfile.medianCombinedMs))
    : null;
  let selectedMode = mode;
  let reason = `explicit-${mode}`;
  if (controlLimitOverride !== null) {
    selectedMode = "budgeted";
    reason = "explicit-control-limit";
  } else if (mode === "auto") {
    if (!measured) {
      selectedMode = "pilot";
      reason = "execution-time-not-measured";
    } else if (eligible.length <= pairLimit && estimatedTotalMs <= timeBudgetMs) {
      selectedMode = "exhaustive";
      reason = "pair-count-and-runtime-fit-budget";
    } else {
      selectedMode = "budgeted";
      reason = eligible.length > pairLimit ? "pair-count-exceeds-limit" : "estimated-runtime-exceeds-budget";
    }
  }
  if (!["pilot", "exhaustive", "budgeted"].includes(selectedMode)) throw new Error(`unsupported verification mode: ${selectedMode}`);
  const totalLimit = selectedMode === "exhaustive" ? eligible.length
    : selectedMode === "pilot" ? Math.max(0, Number(pilotLimit) || 0)
      : Math.max(0, Number(budgetedLimit) || 0);
  const riskTarget = Math.ceil(totalLimit * 0.7);
  const selectedAlerts = controlLimitOverride !== null || selectedMode === "exhaustive"
    ? alerts
    : alerts.slice(0, riskTarget);
  const requestedControls = controlLimitOverride !== null ? Number(controlLimitOverride)
    : selectedMode === "exhaustive" ? noAlertCount
      : Math.max(0, totalLimit - selectedAlerts.length);
  const boundedControls = Math.max(0, Math.min(noAlertCount, Number(requestedControls) || 0));
  const controls = selectedMode === "budgeted" && controlLimitOverride === null
    ? weightedBudget(buckets, totalLimit, selectedAlerts.length).slice(0, boundedControls)
    : roundRobin(buckets, boundedControls);
  return {
    schemaVersion: "live-verification-policy-v0.1",
    requestedMode: mode,
    mode: selectedMode,
    reason,
    eligibleCleanPairCount: eligible.length,
    noAlertPairCount: noAlertCount,
    alertPairCount: alerts.length,
    selectedAlertPairCount: selectedAlerts.length,
    selectedNoAlertPairCount: controls.length,
    selectedPairCount: selectedAlerts.length + controls.length,
    selectedAlertLogicalKeys: selectedAlerts.map((item) => item.logicalKey),
    pairLimit,
    timeBudgetMs,
    measuredExecutionProfile: measured,
    estimatedTotalMs,
    executionProfile,
    controls,
  };
}

/** Summarizes uncached execution costs for the next repository policy decision. */
export function buildExecutionProfiles(results = [], generatedAt = new Date().toISOString()) {
  const groups = new Map();
  for (const result of results) {
    if (!result.repository) continue;
    if (!groups.has(result.repository)) groups.set(result.repository, { base: [], single: [], combined: [] });
    const group = groups.get(result.repository);
    let combinedTotal = 0;
    let hasCombined = false;
    for (const run of result.verification?.runs || []) {
      if (run.cached || !Number.isFinite(run.durationMs) || run.durationMs < 0) continue;
      if (run.label === "base") group.base.push(run.durationMs);
      else if (["a", "b"].includes(run.label)) group.single.push(run.durationMs);
      else if (["combined", "combined_confirmation"].includes(run.label)) {
        combinedTotal += run.durationMs;
        hasCombined = true;
      }
    }
    if (hasCombined) group.combined.push(combinedTotal);
  }
  return [...groups.entries()].flatMap(([repository, samples]) => {
    const medianCombinedMs = median(samples.combined);
    if (medianCombinedMs === null) return [];
    return [{
      schemaVersion: "live-execution-profile-v0.1",
      repository,
      generatedAt,
      medianBaseMs: median(samples.base),
      medianSingleMs: median(samples.single),
      medianCombinedMs,
      samples: { base: samples.base.length, single: samples.single.length, combined: samples.combined.length },
    }];
  });
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
