const NORMALIZED_FAILURE = /(?:error(?:\[[A-Z0-9]+\])?|fail(?:ed|ure)?|exception|panic|assertion)[^\n]*/gi;

export function failureSignatures(output = "") {
  return [...new Set((output.match(NORMALIZED_FAILURE) || [])
    .map((line) => line.toLowerCase()
      .replace(/0x[0-9a-f]+/g, "0x#")
      .replace(/\b\d+(?:\.\d+)?\b/g, "#")
      .replace(/\s+/g, " ")
      .trim())
    // Summaries such as "1 failed" carry no causal identity and can make
    // unrelated failures look like the same reproducible regression.
    .filter((line) => line && !/^(?:#\s+)?(?:failed|failures?)$/.test(line)))];
}

function excluded(reasonCode, rationale, runs) {
  return {
    verdict: "excluded",
    reasonCode,
    semanticBenchmarkEligibility: "excluded",
    rationale,
    evidence: runs.map(([label, run]) => `${label}: ${run?.status || "not-run"}`),
  };
}

export function classifyCombinedRuns({ base, a, b, combined, confirmation = null }) {
  if (base.status !== "passed") {
    const reasonCode = base.status === "failed" ? "baseline-failure" : "baseline-unverified";
    return excluded(
      reasonCode,
      base.status === "failed"
        ? "Base fails, so this is a pre-existing issue and is excluded from semantic-conflict evaluation."
        : "Base execution could not be completed, so this pair is excluded from semantic-conflict evaluation.",
      [["Base", base]],
    );
  }
  if (!a || !b) {
    return excluded("independent-runs-missing", "Independent execution results for PR A and PR B are missing, so this pair is excluded from semantic-conflict evaluation.", [["A", a], ["B", b]]);
  }
  if (a.status !== "passed" || b.status !== "passed") {
    const failed = [["A", a], ["B", b]].filter(([, run]) => run.status === "failed").map(([label]) => label);
    const incomplete = [["A", a], ["B", b]].filter(([, run]) => !["passed", "failed"].includes(run.status)).map(([label]) => label);
    if (incomplete.length) {
      return excluded(
        "independent-run-unverified",
        `Independent execution for ${incomplete.join("/")} could not be completed, so this pair is excluded from semantic-conflict evaluation.`,
        [["A", a], ["B", b]],
      );
    }
    const reasonCode = failed.length === 2 ? "independent-pr-regressions" : `single-pr-regression-${failed[0].toLowerCase()}`;
    return excluded(
      reasonCode,
      failed.length === 2
        ? "PR A and PR B each fail independently, so this is not a pair-induced regression."
        : `PR ${failed[0]} fails independently, so this is not a pair-induced regression.`,
      [["A", a], ["B", b]],
    );
  }
  if (!combined) {
    return { verdict: "insufficient", reasonCode: "combined-run-missing", rationale: "The A+B execution result is missing, so pair-induced causality cannot be determined.", evidence: ["A+B: not-run"] };
  }
  if (combined.status === "passed") {
    return { verdict: "compatible", rationale: "A and B pass independently, and A+B also passes.", evidence: ["A: passed", "B: passed", "A+B: passed"] };
  }
  if (combined.status === "failed") {
    if (!confirmation || confirmation.status !== "failed") {
      return { verdict: "insufficient", rationale: "The A+B failure was not reproduced.", evidence: [`A+B: ${combined.status}`, `confirmation: ${confirmation?.status || "missing"}`] };
    }
    const first = new Set(failureSignatures(combined.output));
    const repeated = failureSignatures(confirmation.output).filter((signature) => first.has(signature));
    if (!repeated.length) return { verdict: "insufficient", rationale: "The two A+B failures do not share a matching signature.", evidence: ["combined failures did not share a normalized signature"] };
    return { verdict: "conflict", rationale: "A and B pass independently, but the same failure is reproduced in A+B.", evidence: repeated.slice(0, 10) };
  }
  return { verdict: "insufficient", reasonCode: "combined-run-unverified", rationale: "The execution result alone cannot establish pair-induced causality.", evidence: [`A+B: ${combined.status}`] };
}
