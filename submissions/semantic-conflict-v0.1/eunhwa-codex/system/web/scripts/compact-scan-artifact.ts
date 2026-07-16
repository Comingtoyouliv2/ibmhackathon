import fs from "node:fs";
import type { AnalysisResult } from "../app/lib/analyzer.ts";

type ScanResult = AnalysisResult & {
  repository: string;
  scanErrors?: unknown[];
};

type ScanPayload = {
  results: ScanResult[];
  [key: string]: unknown;
};

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: compact-scan-artifact <input.json> <output.json>");
const payload = JSON.parse(fs.readFileSync(input, "utf8")) as ScanPayload;
payload.results = payload.results.map((result) => {
  const semanticCandidates = (result.semanticCandidates ?? result.candidates).slice(0, 400);
  const conflicts = result.conflicts.slice(0, 400);
  const needsVerification = (result.needsVerification ?? []).slice(0, 400);
  const pairTextConflicts = (result.pairTextConflicts ?? []).slice(0, 400);
  const llmFindings = (result.llmFindings ?? []).slice(0, 400);
  const pairMergeErrors = (result.pairMergeErrors ?? []).slice(0, 100);
  const findingSummary = {
    conflicts: result.conflicts.length,
    needsVerification: result.needsVerification?.length ?? 0,
    pairTextConflicts: result.pairTextConflicts?.length ?? 0,
    llmFindings: result.llmFindings?.length ?? 0,
    pairMergeErrors: result.pairMergeErrors?.length ?? 0,
    scanErrors: result.scanErrors?.length ?? 0,
  };
  const keep = new Set<number>();
  const resourcesByPr = new Map<number, Set<string>>();
  for (const pair of [...semanticCandidates, ...conflicts, ...needsVerification, ...pairTextConflicts, ...llmFindings, ...(result.combinedVerifications ?? [])]) {
    keep.add(pair.a);
    keep.add(pair.b);
    for (const pr of [pair.a, pair.b]) {
      const resources = resourcesByPr.get(pr) ?? new Set<string>();
      for (const resource of pair.sharedResources) resources.add(resource);
      resourcesByPr.set(pr, resources);
    }
  }
  for (const card of result.cards) {
    if (card.facts.some((fact) => fact.kind === "definition_change")) keep.add(card.pr);
  }
  const semanticCards = result.cards.filter((card) => keep.has(card.pr)).map((card) => ({
    ...card,
    files: [],
    fileChanges: [],
    touchedResources: [...(resourcesByPr.get(card.pr) ?? [])].sort(),
    assumptions: [],
    facts: card.facts.filter((fact) => fact.kind === "definition_change").slice(0, 1),
  }));
  const semanticByPr = new Map(semanticCards.map((card) => [card.pr, card]));
  const pairMergeCards = (result.pairMergeCards ?? result.cards).filter((card) => keep.has(card.pr)).map((card) => semanticByPr.get(card.pr) ?? {
    ...card,
    files: [],
    fileChanges: [],
    touchedResources: [...(resourcesByPr.get(card.pr) ?? [])].sort(),
    assumptions: [],
    facts: [],
  });
  return {
    repository: result.repository,
    totalOpenPrs: result.totalOpenPrs,
    scannedPrs: result.scannedPrs,
    eligibleGatePrs: result.eligibleGatePrs,
    pairMergeGatePrs: result.pairMergeGatePrs,
    eligiblePrs: result.eligiblePrs,
    pairMergePrs: result.pairMergePrs,
    pairMergeUnavailablePrs: result.pairMergeUnavailablePrs,
    pairMergeVerifiedAt: result.pairMergeVerifiedAt,
    pairMergeErrors,
    llmJudgeSummary: result.llmJudgeSummary,
    llmFindings,
    llmJudgeErrors: result.llmJudgeErrors ?? [],
    combinedVerificationSummary: result.combinedVerificationSummary,
    combinedVerifications: result.combinedVerifications ?? [],
    combinedVerificationErrors: result.combinedVerificationErrors ?? [],
    candidates: result.candidates,
    semanticCandidates,
    gitCandidates: [],
    candidateSummary: result.candidateSummary,
    findingSummary,
    conflicts,
    needsVerification,
    pairTextConflicts,
    scanErrors: (result.scanErrors ?? []).slice(0, 100),
    excluded: [],
    cards: semanticCards,
    pairMergeCards,
  };
});
fs.writeFileSync(output, JSON.stringify(payload, null, 2));
