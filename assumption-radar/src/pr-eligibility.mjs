// Only a completed failure is strong enough to remove a PR before execution.
// Cancelled, timed-out, or action-required checks may be infrastructure or
// approval problems, so the Base/A/B verifier must make the final decision.
const FAILED_CHECK_CONCLUSIONS = new Set(["failure"]);
const PASSING_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

function latestRunsByName(checkRuns) {
  const latest = new Map();
  for (const check of checkRuns) {
    const key = check.name || String(check.id || "unnamed-check");
    const previous = latest.get(key);
    const timestamp = Date.parse(check.completed_at || check.started_at || check.created_at || 0) || Number(check.id || 0);
    const previousTimestamp = previous
      ? Date.parse(previous.completed_at || previous.started_at || previous.created_at || 0) || Number(previous.id || 0)
      : -1;
    if (!previous || timestamp >= previousTimestamp) latest.set(key, check);
  }
  return [...latest.values()];
}

export function summarizeCommitChecks(checkRuns = [], combinedStatus = null) {
  const currentRuns = latestRunsByName(checkRuns);
  const failedChecks = currentRuns
    .filter((check) => FAILED_CHECK_CONCLUSIONS.has(check.conclusion))
    .map((check) => check.name)
    .filter(Boolean);
  const pendingChecks = currentRuns
    .filter((check) => check.status !== "completed")
    .map((check) => check.name)
    .filter(Boolean);
  const inconclusiveChecks = currentRuns
    .filter((check) => check.status === "completed" && !FAILED_CHECK_CONCLUSIONS.has(check.conclusion) && !PASSING_CHECK_CONCLUSIONS.has(check.conclusion))
    .map((check) => check.name)
    .filter(Boolean);
  const legacyFailed = combinedStatus?.state === "failure";
  const legacyPending = combinedStatus?.state === "pending" && Number(combinedStatus?.total_count || 0) > 0;
  const legacyInconclusive = combinedStatus?.state === "error";
  const totalChecks = currentRuns.length + Number(combinedStatus?.total_count || 0);

  return {
    status: failedChecks.length || legacyFailed ? "failed"
      : pendingChecks.length || legacyPending ? "pending"
        : inconclusiveChecks.length || legacyInconclusive ? "unknown"
          : totalChecks ? "passed" : "unknown",
    totalChecks,
    failedChecks,
    pendingChecks,
    inconclusiveChecks,
    legacyStatus: combinedStatus?.state || null,
  };
}

export function pullRequestEligibility(pr) {
  if (pr.draft) return { eligible: false, reasonCode: "draft-pr" };
  if (pr.ci?.status === "failed") {
    return {
      eligible: false,
      reasonCode: "failed-ci",
      failedChecks: pr.ci.failedChecks || [],
    };
  }
  return {
    eligible: true,
    reasonCode: pr.ci?.status === "passed" ? "ci-passed" : `ci-${pr.ci?.status || "unknown"}`,
  };
}

export function partitionEligiblePullRequests(prs = []) {
  const eligible = [];
  const excluded = [];
  for (const pr of prs) {
    const decision = pullRequestEligibility(pr);
    if (decision.eligible) eligible.push(pr);
    else excluded.push({ number: pr.number, headSha: pr.headSha || null, ...decision });
  }
  return {
    eligible,
    excluded,
    summary: {
      fetched: prs.length,
      eligible: eligible.length,
      excluded: excluded.length,
      draft: excluded.filter((item) => item.reasonCode === "draft-pr").length,
      failedCi: excluded.filter((item) => item.reasonCode === "failed-ci").length,
    },
  };
}
