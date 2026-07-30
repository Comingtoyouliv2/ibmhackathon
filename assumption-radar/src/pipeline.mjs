import { explainCoordination } from "./coordination.mjs";
import { prepareIntegratedAnalysis } from "./integrated.mjs";
import { GitMergeTreePreflight } from "./preflight.mjs";

function rawNumber(pr, index) {
  return Number(pr.number ?? index + 1);
}

function needsPairContext(comparison) {
  return comparison.witnesses.length > 0
    || ((comparison.retrievalScore || 0) > 0 && (comparison.retrievalFeatures?.priority ?? 3) <= 1);
}

export function applyMergeTreeResults(prepared, inspections) {
  const byKey = new Map(inspections.map((inspection) => [inspection.key, inspection]));
  const prsById = new Map(prepared.prs.map((pr) => [pr.id, pr]));
  const rank = { conflict: 0, coordination: 1, review: 2, insufficient: 3, independent: 4 };
  const comparisons = prepared.comparisons.map((comparison) => {
    const inspection = byKey.get(comparison.key);
    if (!inspection) return comparison;
    if (inspection.status === "base-conflict") {
      return {
        ...comparison,
        verdict: "insufficient",
        title: "Pairwise analysis deferred because an individual PR conflicts with the current base",
        summary: `PR ${inspection.baseConflictPrNumbers.map((number) => `#${number}`).join(", ")} conflicts with the current base first. Rebase it before judging the relationship between the two PRs.`,
        consequence: "Mixing base conflicts with cross-PR conflicts duplicates the same root cause across many pair alerts.",
        recommendation: "Rebase the affected PR onto the current base, restore individual mergeability, and rerun pairwise analysis.",
        basis: "base-conflict",
        source: "git-preflight",
        mechanicalMerge: "base-conflict",
        semanticBenchmarkEligibility: "excluded",
        preflight: inspection,
      };
    }
    if (inspection.status !== "textual-conflict") return { ...comparison, mechanicalMerge: inspection.status, preflight: inspection };
    const paths = inspection.conflictPaths.length ? inspection.conflictPaths : ["git merge-tree conflict"];
    const explanation = explainCoordination(comparison, inspection, prsById);
    return {
      ...comparison,
      verdict: "coordination",
      category: "rollout",
      title: explanation.title || `Git merge conflict requires coordination first${inspection.conflictPaths.length ? `: ${inspection.conflictPaths.slice(0, 2).join(", ")}` : ""}`,
      summary: explanation.summary || "The PRs have a mechanical merge conflict and are excluded from silent semantic-conflict evaluation. Run the relevant tests while resolving it so neither intent is lost.",
      consequence: explanation.consequence || "Git stops the merge, but one side's change or bug fix may be lost during conflict resolution.",
      recommendation: explanation.recommendation || "Review the conflicting files together and resolve them on an integration branch that preserves both PRs' regression tests.",
      evidence: [...paths, ...explanation.explanationEvidence.flatMap((item) => item.evidence)].filter((value, index, values) => values.indexOf(value) === index).slice(0, 8),
      basis: "merge-tree-textual-conflict",
      source: "git-preflight",
      relationship: "coordination-required",
      coordinationSubtype: explanation.coordinationSubtype,
      requiredAction: explanation.requiredAction,
      actionConfidence: explanation.actionConfidence,
      explanationEvidence: explanation.explanationEvidence,
      ...(explanation.validStrategies ? { validStrategies: explanation.validStrategies } : {}),
      ...(explanation.invalidOutcome ? { invalidOutcome: explanation.invalidOutcome } : {}),
      ...(explanation.protectedPrNumber ? { protectedPrNumber: explanation.protectedPrNumber } : {}),
      mechanicalMerge: "conflict",
      semanticBenchmarkEligibility: "excluded",
      observability: "merge-tree-required",
      preflight: inspection,
    };
  }).sort((a, b) => rank[a.verdict] - rank[b.verdict]
    || (a.retrievalFeatures?.priority ?? 3) - (b.retrievalFeatures?.priority ?? 3)
    || (b.retrievalScore || 0) - (a.retrievalScore || 0)
    || b.witnesses.length - a.witnesses.length);
  return {
    ...prepared,
    comparisons,
    candidates: comparisons.filter((item) => item.verdict !== "independent" && needsPairContext(item)),
  };
}

export async function prepareAnalysisPipeline(prs, options = {}) {
  let prepared = prepareIntegratedAnalysis(prs, options);
  const metadata = { status: "disabled", stacks: [], suppressedPrNumbers: [], basePreparedPrs: 0, baseConflictPrNumbers: [], baseUnavailablePrNumbers: [], inspectedPairs: 0, cleanPairs: 0, textualConflictPairs: 0, baseConflictPairs: 0, unavailablePairs: 0 };
  if (!options.useMergePreflight || !options.repository) return { prepared, preflight: metadata };

  const interactionComparisons = prepared.comparisons.filter(needsPairContext);
  const relevantIds = new Set(interactionComparisons.flatMap((item) => item.prIds));
  const relevantPrs = prepared.prs.filter((pr) => relevantIds.has(pr.id));
  if (relevantPrs.length < 2) return { prepared, preflight: { ...metadata, status: "skipped", reason: "no interacting PR pairs" } };

  const engine = options.preflightEngine || new GitMergeTreePreflight(options.repository, { cacheDir: options.cacheDir });
  try {
    const cache = await engine.initialize(relevantPrs);
    const stacks = await engine.findStacks(relevantPrs);
    const suppressedNumbers = new Set(stacks.map((stack) => stack.ancestorNumber));
    if (suppressedNumbers.size) {
      const collapsed = prs.filter((pr, index) => !suppressedNumbers.has(rawNumber(pr, index)));
      prepared = prepareIntegratedAnalysis(collapsed, options);
    }
    const baseMerges = engine.prepareBaseMerges ? await engine.prepareBaseMerges(prepared.prs) : prepared.prs.map((pr) => ({ prNumber: pr.number, status: "clean" }));
    const inspectable = prepared.comparisons.filter(needsPairContext);
    const inspections = await engine.inspectPairs(inspectable, prepared.prs);
    prepared = applyMergeTreeResults(prepared, inspections);
    return {
      prepared,
      preflight: {
        status: "complete",
        cacheDir: cache.repoDir,
        fetchedPrs: cache.fetchedPrs,
        fetchedBases: cache.fetchedBases || [],
        stacks,
        suppressedPrNumbers: [...suppressedNumbers].sort((a, b) => a - b),
        basePreparedPrs: baseMerges.filter((item) => item.status === "clean").length,
        baseConflictPrNumbers: baseMerges.filter((item) => item.status === "base-conflict").map((item) => item.prNumber).sort((a, b) => a - b),
        baseUnavailablePrNumbers: baseMerges.filter((item) => item.status === "unavailable").map((item) => item.prNumber).sort((a, b) => a - b),
        inspectedPairs: inspections.length,
        cleanPairs: inspections.filter((item) => item.status === "clean").length,
        textualConflictPairs: inspections.filter((item) => item.status === "textual-conflict").length,
        baseConflictPairs: inspections.filter((item) => item.status === "base-conflict").length,
        unavailablePairs: inspections.filter((item) => item.status === "unavailable").length,
      },
    };
  } catch (error) {
    return { prepared, preflight: { ...metadata, status: "unavailable", error: error.message } };
  }
}
