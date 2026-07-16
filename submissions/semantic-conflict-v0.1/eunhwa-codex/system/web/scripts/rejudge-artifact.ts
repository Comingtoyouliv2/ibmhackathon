import fs from "node:fs";
import { generateBroadSemanticCandidates, generateCandidates, judgeCandidates, type AnalysisResult } from "../app/lib/analyzer.ts";
import { generateFileOverlapCandidates } from "../app/lib/pair-merge.ts";

type ScanResult = AnalysisResult & {
  repository: string;
  scanErrors: Array<{ pr: number; reason: string }>;
};

type ScanArtifact = {
  startedAt: string;
  finishedAt: string;
  limit: number | null;
  results: ScanResult[];
};

const [source] = process.argv.slice(2);
if (!source) throw new Error("Usage: rejudge-artifact <artifact.json>");
const artifact = JSON.parse(fs.readFileSync(source, "utf8")) as ScanArtifact;

for (const result of artifact.results) {
  if (result.totalOpenPrs !== undefined && result.scannedPrs !== undefined && result.totalOpenPrs < result.scannedPrs) {
    result.totalOpenPrs = result.scannedPrs;
  }
  const textConflictKeys = new Set((result.pairTextConflicts ?? []).map((pair) => `${Math.min(pair.a, pair.b)}:${Math.max(pair.a, pair.b)}`));
  result.candidates = generateCandidates(result.cards).filter((pair) => !textConflictKeys.has(`${pair.a}:${pair.b}`));
  result.semanticCandidates = generateBroadSemanticCandidates(result.cards, result.candidates).filter((pair) => !textConflictKeys.has(`${pair.a}:${pair.b}`));
  result.gitCandidates = generateFileOverlapCandidates(result.pairMergeCards ?? result.cards);
  result.candidateSummary = {
    gitPairs: result.gitCandidates.length,
    contractPairs: result.candidates.length,
    broadSemanticPairs: result.semanticCandidates.length,
    strongSemanticPairs: result.semanticCandidates.filter((pair) => pair.candidateTier === "strong").length,
    mediumSemanticPairs: result.semanticCandidates.filter((pair) => pair.candidateTier === "medium").length,
    weakSemanticPairs: result.semanticCandidates.filter((pair) => pair.candidateTier === "weak").length,
  };
  // Patch interaction findings require raw diffs, which compact scan artifacts
  // intentionally do not retain. Preserve findings produced during the scan.
  const patchInteractionFindings = (result.needsVerification ?? [])
    .filter((finding) => finding.reasonCode === "patch_interaction");
  const judgments = judgeCandidates(result.cards, result.candidates);
  result.conflicts = judgments.conflicts;
  result.needsVerification = [...judgments.needsVerification, ...patchInteractionFindings];
}
artifact.finishedAt = new Date().toISOString();
fs.writeFileSync(source, JSON.stringify(artifact, null, 2));

const lines = [
  "# OSS PR-pair conflict scan",
  "",
  `Scanned: ${artifact.finishedAt}`,
  "Window: all open PRs per repository",
  "",
  "| repository | total open | scanned | pair-merge eligible (CI pass) | file-overlap pairs | text conflicts | combined verified | active LLM risks | static semantic conflicts | fetch errors |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...artifact.results.map((result) => {
    const textKeys = new Set((result.pairTextConflicts ?? []).map((pair) => `${Math.min(pair.a, pair.b)}:${Math.max(pair.a, pair.b)}`));
    const cleanKeys = new Set((result.combinedVerifications ?? []).filter((pair) => pair.verdict === "combined_clean").map((pair) => `${Math.min(pair.a, pair.b)}:${Math.max(pair.a, pair.b)}`));
    const activeLlm = (result.llmFindings ?? []).filter((pair) => pair.verdict === "llm_conflict" && !textKeys.has(`${Math.min(pair.a, pair.b)}:${Math.max(pair.a, pair.b)}`) && !cleanKeys.has(`${Math.min(pair.a, pair.b)}:${Math.max(pair.a, pair.b)}`)).length;
    return `| ${result.repository} | ${result.totalOpenPrs} | ${result.scannedPrs} | ${result.pairMergeGatePrs ?? result.eligibleGatePrs} (${result.eligibleGatePrs} CI pass) | ${generateFileOverlapCandidates(result.pairMergeCards ?? result.cards).length} | ${result.pairTextConflicts?.length ?? 0} | ${result.combinedVerificationSummary?.verifiedPairs ?? 0} | ${activeLlm} | ${result.conflicts.length} | ${result.scanErrors.length} |`;
  }),
  "",
];

for (const result of artifact.results) {
  lines.push(`## ${result.repository}`, "");
  if (result.conflicts.length === 0) lines.push("- No statically confirmed, pair-text-disjoint contract conflict detected.");
  for (const conflict of result.conflicts) lines.push(`- CONFIRMED #${conflict.a} x #${conflict.b}: ${conflict.rationale} (${conflict.sharedResources.join(", ")})`);
  if (result.llmFindings?.length) {
    lines.push("", "LLM semantic risks (not static proof):");
    for (const finding of result.llmFindings) lines.push(`- #${finding.a} x #${finding.b} [${finding.verdict}/${finding.family}]: ${finding.claim} (${finding.sharedResources.join(", ")})`);
  }
  if (result.combinedVerifications?.length) {
    lines.push("", "Same-base combined verification:");
    for (const finding of result.combinedVerifications) lines.push(`- #${finding.a} x #${finding.b} [${finding.verdict}]: ${finding.rationale}`);
  }
  if (result.needsVerification?.length) {
    lines.push("", "Needs pair merge/runtime verification:");
    for (const finding of result.needsVerification) lines.push(`- #${finding.a} x #${finding.b} [${finding.reasonCode}]: ${finding.rationale} (${finding.sharedResources.join(", ")})`);
  }
  if (result.pairTextConflicts?.length) {
    lines.push("", "Git pair text conflicts:");
    for (const finding of result.pairTextConflicts) lines.push(`- #${finding.a} x #${finding.b}: ${finding.rationale}`);
  }
  if (result.pairMergeErrors?.length) {
    lines.push("", "Pair merge errors:");
    for (const error of result.pairMergeErrors) lines.push(`- #${error.a} x #${error.b}: ${error.reason}`);
  }
  lines.push("");
}

const markdown = source.replace(/\.json$/i, ".md");
fs.writeFileSync(markdown, lines.join("\n"));
console.log(`Rejudged ${artifact.results.length} repositories → ${source}`);
