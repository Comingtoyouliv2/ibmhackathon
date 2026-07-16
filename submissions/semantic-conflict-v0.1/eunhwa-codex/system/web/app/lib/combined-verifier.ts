import type { Candidate } from "./analyzer";

export type CombinedRunStatus = "passed" | "failed" | "timeout" | "runner_error";

export type CombinedRun = {
  label: "pr_a" | "pr_b" | "combined" | "combined_confirmation";
  status: CombinedRunStatus;
  command: string;
  exitCode: number | null;
  durationMs: number;
  failureSignatures: string[];
  output: string;
};

export type CombinedVerification = Candidate & {
  verdict: "combined_conflict" | "combined_clean" | "combined_inconclusive";
  rationale: string;
  runs: CombinedRun[];
  evidence: string[];
  baseSha: string;
  headShaA: string;
  headShaB: string;
  profile: string;
  verifiedAt: string;
};

export type CombinedVerificationSummary = {
  candidatePairs: number;
  verifiedPairs: number;
  conflicts: number;
  clean: number;
  inconclusive: number;
  skipped: number;
  startedAt: string;
  finishedAt: string;
};

export function failureSignatures(output: string): string[] {
  return [...new Set(output
    .split("\n")
    .map((line) => line
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/gi, "<time>")
      .replace(/\/tmp\/[A-Za-z0-9._/-]+/g, "<tmp>")
      .trim())
    .filter((line) => /(?:fail|error|assert|expected|received|exception|panic|not ok)/i.test(line))
    .filter(Boolean)
    .slice(0, 40))].sort();
}

export function classifyCombinedRuns(
  a: CombinedRun,
  b: CombinedRun,
  combined: CombinedRun,
  confirmation?: CombinedRun,
): Pick<CombinedVerification, "verdict" | "rationale" | "evidence"> {
  if (a.status === "passed" && b.status === "passed" && combined.status === "passed") {
    return {
      verdict: "combined_clean",
      rationale: "두 PR의 단독 검증과 실제 combined tree 검증이 모두 통과했습니다.",
      evidence: ["PR A: passed", "PR B: passed", "combined: passed"],
    };
  }
  if (a.status === "passed" && b.status === "passed" && combined.status === "failed") {
    if (!confirmation || confirmation.status !== "failed") {
      return {
        verdict: "combined_inconclusive",
        rationale: "combined tree가 실패했지만 동일 실패가 반복 재현되지 않았습니다.",
        evidence: [`combined: ${combined.status}`, `confirmation: ${confirmation?.status ?? "missing"}`],
      };
    }
    const first = new Set(combined.failureSignatures);
    const repeated = confirmation.failureSignatures.filter((signature) => first.has(signature));
    if (first.size > 0 && confirmation.failureSignatures.length > 0 && repeated.length === 0) {
      return {
        verdict: "combined_inconclusive",
        rationale: "두 combined 실행이 서로 다른 실패를 보여 재현 가능한 pair 결함으로 확정할 수 없습니다.",
        evidence: ["combined failures did not share a normalized signature"],
      };
    }
    return {
      verdict: "combined_conflict",
      rationale: "두 PR은 각각 통과하지만 실제 combined tree에서만 동일 실패가 반복 발생했습니다.",
      evidence: repeated.length > 0 ? repeated.slice(0, 10) : ["combined returned the same non-zero result twice"],
    };
  }
  return {
    verdict: "combined_inconclusive",
    rationale: "단독 PR 실패 또는 실행기 오류가 있어 combined 실패를 PR 상호작용에 귀속할 수 없습니다.",
    evidence: [`PR A: ${a.status}`, `PR B: ${b.status}`, `combined: ${combined.status}`],
  };
}
