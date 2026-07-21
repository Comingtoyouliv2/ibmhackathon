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
        ? "Base가 실패하므로 기존 문제이며 semantic conflict 평가에서 제외합니다."
        : "Base 실행을 완료하지 못해 semantic conflict 평가에서 제외합니다.",
      [["Base", base]],
    );
  }
  if (!a || !b) {
    return excluded("independent-runs-missing", "PR A/B 독립 실행 결과가 없어 semantic conflict 평가에서 제외합니다.", [["A", a], ["B", b]]);
  }
  if (a.status !== "passed" || b.status !== "passed") {
    const failed = [["A", a], ["B", b]].filter(([, run]) => run.status === "failed").map(([label]) => label);
    const incomplete = [["A", a], ["B", b]].filter(([, run]) => !["passed", "failed"].includes(run.status)).map(([label]) => label);
    if (incomplete.length) {
      return excluded(
        "independent-run-unverified",
        `${incomplete.join("/")} 독립 실행을 완료하지 못해 semantic conflict 평가에서 제외합니다.`,
        [["A", a], ["B", b]],
      );
    }
    const reasonCode = failed.length === 2 ? "independent-pr-regressions" : `single-pr-regression-${failed[0].toLowerCase()}`;
    return excluded(
      reasonCode,
      failed.length === 2
        ? "PR A와 B가 각각 단독으로 실패하므로 pair-induced regression이 아닙니다."
        : `PR ${failed[0]}가 단독으로 실패하므로 pair-induced regression이 아닙니다.`,
      [["A", a], ["B", b]],
    );
  }
  if (!combined) {
    return { verdict: "insufficient", reasonCode: "combined-run-missing", rationale: "A+B 실행 결과가 없어 pair-induced 원인을 판정할 수 없습니다.", evidence: ["A+B: not-run"] };
  }
  if (combined.status === "passed") {
    return { verdict: "compatible", rationale: "A와 B가 각각 통과하고 A+B도 통과했습니다.", evidence: ["A: passed", "B: passed", "A+B: passed"] };
  }
  if (combined.status === "failed") {
    if (!confirmation || confirmation.status !== "failed") {
      return { verdict: "insufficient", rationale: "A+B 실패가 재현되지 않았습니다.", evidence: [`A+B: ${combined.status}`, `confirmation: ${confirmation?.status || "missing"}`] };
    }
    const first = new Set(failureSignatures(combined.output));
    const repeated = failureSignatures(confirmation.output).filter((signature) => first.has(signature));
    if (!repeated.length) return { verdict: "insufficient", rationale: "두 A+B 실패의 signature가 일치하지 않습니다.", evidence: ["combined failures did not share a normalized signature"] };
    return { verdict: "conflict", rationale: "A와 B는 독립적으로 통과하지만 A+B에서 동일 실패가 재현됩니다.", evidence: repeated.slice(0, 10) };
  }
  return { verdict: "insufficient", reasonCode: "combined-run-unverified", rationale: "실행 결과만으로 pair-induced 원인을 확정할 수 없습니다.", evidence: [`A+B: ${combined.status}`] };
}
