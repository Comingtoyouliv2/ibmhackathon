import { prepareAnalysis } from "./analyzer.mjs";
import { explainCoordination } from "./coordination.mjs";
import { GitMergeTreePreflight } from "./preflight.mjs";

function rawNumber(pr, index) {
  return Number(pr.number ?? index + 1);
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
        title: "개별 PR이 현재 base와 충돌해 pairwise 분석을 보류함",
        summary: `PR ${inspection.baseConflictPrNumbers.map((number) => `#${number}`).join(", ")}이 현재 base와 먼저 충돌합니다. 두 PR 사이의 관계를 판정하기 전에 해당 PR을 rebase해야 합니다.`,
        consequence: "base 충돌과 PR 간 충돌을 섞으면 같은 원인이 여러 pair 경고로 중복됩니다.",
        recommendation: "해당 PR을 현재 base에 rebase하고 개별 mergeability를 회복한 뒤 pairwise 분석을 다시 실행하세요.",
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
      title: explanation.title || `Git merge conflict로 먼저 조율해야 함${inspection.conflictPaths.length ? `: ${inspection.conflictPaths.slice(0, 2).join(", ")}` : ""}`,
      summary: explanation.summary || "두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다.",
      consequence: explanation.consequence || "Git이 merge를 중단하지만, 해소 과정에서 한쪽의 변경이나 버그 수정이 유실될 수 있습니다.",
      recommendation: explanation.recommendation || "충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요.",
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
  }).sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.witnesses.length - a.witnesses.length);
  return {
    ...prepared,
    comparisons,
    candidates: comparisons.filter((item) => item.verdict !== "independent" && item.witnesses.length),
  };
}

export async function prepareAnalysisPipeline(prs, options = {}) {
  let prepared = prepareAnalysis(prs, options);
  const metadata = { status: "disabled", stacks: [], suppressedPrNumbers: [], basePreparedPrs: 0, baseConflictPrNumbers: [], baseUnavailablePrNumbers: [], inspectedPairs: 0, cleanPairs: 0, textualConflictPairs: 0, baseConflictPairs: 0, unavailablePairs: 0 };
  if (!options.useMergePreflight || !options.repository) return { prepared, preflight: metadata };

  const interactionComparisons = prepared.comparisons.filter((item) => item.witnesses.length);
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
      prepared = prepareAnalysis(collapsed, options);
    }
    const baseMerges = engine.prepareBaseMerges ? await engine.prepareBaseMerges(prepared.prs) : prepared.prs.map((pr) => ({ prNumber: pr.number, status: "clean" }));
    const inspectable = prepared.comparisons.filter((item) => item.witnesses.length);
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
