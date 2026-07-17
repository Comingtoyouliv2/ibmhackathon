const NORMALIZED_FAILURE = /(?:error(?:\[[A-Z0-9]+\])?|failed|failure|exception|panic|assertion)[^\n]*/gi;

export function failureSignatures(output = "") {
  return [...new Set((output.match(NORMALIZED_FAILURE) || [])
    .map((line) => line.toLowerCase()
      .replace(/0x[0-9a-f]+/g, "0x#")
      .replace(/\b\d+(?:\.\d+)?\b/g, "#")
      .replace(/\s+/g, " ")
      .trim())
    .filter(Boolean))];
}

export function classifyCombinedRuns({ base, a, b, combined, confirmation = null }) {
  if (a.status === "passed" && b.status === "passed" && combined.status === "passed") {
    return { verdict: "compatible", rationale: "A와 B가 각각 통과하고 A+B도 통과했습니다.", evidence: ["A: passed", "B: passed", "A+B: passed"] };
  }
  if (a.status === "passed" && b.status === "passed" && combined.status === "failed") {
    if (!confirmation || confirmation.status !== "failed") {
      return { verdict: "insufficient", rationale: "A+B 실패가 재현되지 않았습니다.", evidence: [`A+B: ${combined.status}`, `confirmation: ${confirmation?.status || "missing"}`] };
    }
    const first = new Set(failureSignatures(combined.output));
    const repeated = failureSignatures(confirmation.output).filter((signature) => first.has(signature));
    if (!repeated.length) return { verdict: "insufficient", rationale: "두 A+B 실패의 signature가 일치하지 않습니다.", evidence: ["combined failures did not share a normalized signature"] };
    return { verdict: "conflict", rationale: "A와 B는 독립적으로 통과하지만 A+B에서 동일 실패가 재현됩니다.", evidence: repeated.slice(0, 10) };
  }
  if (base.status !== "passed" || a.status !== "passed" || b.status !== "passed") {
    return { verdict: "excluded", rationale: "Base/A/B 독립 정상 조건을 만족하지 않습니다.", evidence: [`Base: ${base.status}`, `A: ${a.status}`, `B: ${b.status}`] };
  }
  return { verdict: "insufficient", rationale: "실행 결과만으로 pair-induced 원인을 확정할 수 없습니다.", evidence: [`A+B: ${combined.status}`] };
}
