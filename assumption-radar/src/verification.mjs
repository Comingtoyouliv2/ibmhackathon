import crypto from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const pairKey = (ids) => [...ids].map(String).sort().join(":");

function isRunnable(comparison) {
  return comparison.mechanicalMerge !== "conflict"
    && comparison.mechanicalMerge !== "base-conflict"
    && comparison.semanticBenchmarkEligibility !== "excluded";
}

/**
 * Selects the highest-ranked semantic findings for expensive executable
 * verification. Retrieval remains broad; Docker execution stays bounded.
 */
export function selectVerificationCandidates(prepared, analysis, options = {}) {
  const limit = Math.max(0, Number(options.limit ?? 3));
  const findings = new Map((analysis.findings || []).map((item) => [pairKey(item.prIds), item]));
  return prepared.comparisons
    .filter(isRunnable)
    .filter((comparison) => findings.has(comparison.key))
    .map((comparison) => ({ ...comparison, semanticFinding: findings.get(comparison.key) }))
    .slice(0, limit);
}

function executionFinding(verification, existing) {
  const base = {
    ...existing,
    verification,
    executionEvidence: verification.classification.evidence,
    verifiedAt: verification.verifiedAt,
  };
  if (verification.classification.verdict === "conflict") {
    return {
      ...base,
      verdict: "conflict",
      relationship: "confirmed-conflict",
      executionStatus: "confirmed-conflict",
      executionSummary: verification.classification.rationale,
      evidenceGrade: "executable",
      goldEvidence: "executable",
      confirmationStatus: "executable-confirmed",
      runtimeVerification: "repeated-failure",
    };
  }
  if (verification.classification.verdict === "compatible") {
    return {
      ...base,
      executionStatus: "no-observed-regression",
      executionSummary: "No pair-induced regression was reproduced within the selected test scope.",
      evidenceGrade: "executable",
      goldEvidence: "executable",
      confirmationStatus: "executable-compatible",
      runtimeVerification: "passed",
    };
  }
  if (verification.classification.verdict === "excluded") {
    return {
      ...base,
      verdict: "excluded",
      relationship: "excluded",
      semanticBenchmarkEligibility: "excluded",
      executionStatus: verification.classification.reasonCode || "excluded-independent-failure",
      executionSummary: verification.classification.rationale,
      goldEvidence: "executable",
    };
  }
  return {
    ...base,
    executionStatus: "inconclusive",
    executionSummary: verification.classification.rationale,
    confirmationStatus: "runtime-inconclusive",
    runtimeVerification: "inconclusive",
  };
}

/** Applies executable outcomes without discarding the static/AI audit trail. */
export function applyVerificationResults(analysis, verifications = []) {
  const byPair = new Map(verifications.map((item) => [pairKey(item.prIds), item]));
  const original = new Map((analysis.findings || []).map((item) => [pairKey(item.prIds), item]));
  const resolved = [...original.entries()].map(([key, finding]) => {
    const verification = byPair.get(key);
    return verification ? executionFinding(verification, finding) : finding;
  });
  const findings = resolved.filter((item) => ["conflict", "coordination", "review"].includes(item.verdict));
  const compatibleVerifications = resolved.filter((item) => item.verification?.classification.verdict === "compatible");
  const conflictCount = findings.filter((item) => item.verdict === "conflict").length;
  const coordinationCount = findings.filter((item) => item.verdict === "coordination").length;
  const reviewCount = findings.filter((item) => item.verdict === "review").length;
  const confirmedConflictCount = verifications.filter((item) => item.classification.verdict === "conflict").length;
  const verifiedCompatibleCount = verifications.filter((item) => item.classification.verdict === "compatible").length;
  const excludedVerificationCount = verifications.filter((item) => item.classification.verdict === "excluded").length;
  const baselineFailureCount = verifications.filter((item) => item.classification.reasonCode?.startsWith("baseline-")).length;
  const singlePrRegressionCount = verifications.filter((item) => item.classification.reasonCode?.startsWith("single-pr-regression-")).length;
  const inconclusiveVerificationCount = verifications.length - confirmedConflictCount - verifiedCompatibleCount - excludedVerificationCount;
  return {
    ...analysis,
    findings,
    conflicts: findings,
    compatibleVerifications,
    verifications,
    summary: {
      ...analysis.summary,
      conflictCount,
      coordinationCount,
      reviewCount,
      verifiedPairCount: verifications.length,
      confirmedConflictCount,
      verifiedCompatibleCount,
      excludedVerificationCount,
      baselineFailureCount,
      singlePrRegressionCount,
      inconclusiveVerificationCount,
      verdict: confirmedConflictCount ? "Pair-induced regression confirmed by execution"
        : conflictCount ? "Static or AI conflict witness found"
          : coordinationCount ? "Git merge coordination required"
            : reviewCount ? "Semantic review required" : "No direct conflict evidence",
    },
  };
}

function evidenceRecords(finding = {}) {
  const counters = { A: 0, B: 0 };
  const structured = (finding.evidenceObjects || []).flatMap((item) => {
    if (!item || !["A", "B"].includes(item.side) || !item.quote) return [];
    counters[item.side] += 1;
    return [{ id: `${item.side}${counters[item.side]}`, ...item }];
  });
  if (structured.length) return structured;
  return (finding.evidence || []).filter(Boolean).slice(0, 12).map((quote, index) => ({
    id: `W${index + 1}`,
    side: "witness",
    file: "",
    symbol: "",
    quote,
  }));
}

function impactFromVerification(verification) {
  const failed = verification.runs.filter((run) => run.status === "failed");
  const signatures = [...new Set(failed.flatMap((run) => run.failureSignatures || []))];
  return {
    type: verification.classification.verdict === "conflict" ? "pair-induced-regression"
      : verification.classification.verdict === "compatible" ? "no-observed-regression"
        : verification.classification.verdict === "excluded" ? verification.classification.reasonCode : "inconclusive",
    severity: verification.classification.verdict === "conflict" ? "unassessed" : "none",
    failedRuns: failed.map((run) => run.label),
    failureSignatures: signatures.slice(0, 20),
    summary: verification.classification.rationale,
  };
}

/** Converts one immutable verification into the append-only JSONL case schema. */
export function verificationCaseRecord({ repository, verification, finding, metadata = {} }) {
  const evidence = evidenceRecords(finding);
  const runs = Object.fromEntries(verification.runs.map((run) => [run.label, {
    status: run.status,
    command: run.command,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    cached: Boolean(run.cached),
    failureSignatures: run.failureSignatures,
  }]));
  return {
    schemaVersion: "1.0",
    eventId: crypto.randomUUID(),
    caseId: `${repository.replaceAll("/", "-")}-${verification.prNumbers[0]}x${verification.prNumbers[1]}`,
    revision: verification.verifiedAt,
    repository,
    baseSha: verification.baseSha,
    prA: { number: verification.prNumbers[0], headSha: verification.headShaA },
    prB: { number: verification.prNumbers[1], headSha: verification.headShaB },
    relationship: verification.classification.verdict === "conflict" ? "confirmed-conflict"
      : verification.classification.verdict === "compatible" ? "compatible"
        : verification.classification.verdict === "excluded" ? "excluded" : "inconclusive",
    semanticBenchmarkEligibility: verification.classification.verdict === "excluded" ? "excluded" : "included",
    exclusionReason: verification.classification.verdict === "excluded" ? verification.classification.reasonCode : null,
    mechanism: finding?.category || "unclassified",
    brokenContract: {
      assumptionA: finding?.assumptionA || "",
      assumptionB: finding?.assumptionB || "",
      violatingChange: finding?.consequence || "",
    },
    impact: impactFromVerification(verification),
    evidence,
    verification: {
      profile: verification.profile,
      classification: verification.classification,
      runs,
      repetitions: verification.runs.filter((run) => run.label.startsWith("combined")).length,
      goldEvidence: "executable",
    },
    metadata: {
      analyzerVersion: metadata.analyzerVersion || "unknown",
      promptVersion: metadata.promptVersion || null,
      model: metadata.model || null,
      generatedAt: verification.verifiedAt,
    },
  };
}

export async function appendVerificationRecords(path, records) {
  if (!path || !records.length) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}
