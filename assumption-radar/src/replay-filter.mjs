const OUTCOMES = new Set(["pass", "fail", "not-applicable", "unavailable"]);

const unique = (values) => [...new Set(values.filter(Boolean))];
const uniqueBy = (values, key) => [...new Map(values.filter(Boolean).map((value) => [key(value), value])).values()];
const isoTime = (value) => {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
};

export function pullNumberFromMergeMessage(message = "") {
  const merge = message.match(/Merge pull request #(\d+)/i);
  if (merge) return Number(merge[1]);
  const squash = message.match(/\(#(\d+)\)(?:\s|$)/);
  return squash ? Number(squash[1]) : null;
}

export function closingIssueReferences(text = "", defaultRepository = null) {
  const value = String(text);
  const references = [];
  for (const match of value.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)) {
    references.push({ repository: defaultRepository, number: Number(match[1]) });
  }
  for (const match of value.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+([\w.-]+\/[\w.-]+)#(\d+)\b/gi)) {
    references.push({ repository: match[1], number: Number(match[2]) });
  }
  for (const match of value.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\b/gi)) {
    references.push({ repository: match[1], number: Number(match[2]) });
  }
  return uniqueBy(references, (item) => `${item.repository || ""}#${item.number}`);
}

export function closingIssueNumbers(text = "") {
  return closingIssueReferences(text).map((item) => item.number);
}

export function candidateFamilyKey(candidate) {
  const lineage = candidate.evidence?.lineage || {};
  const commits = unique([...(lineage.sideACommits || []), ...(lineage.sideBCommits || [])]).sort();
  const fixingCommit = candidate.fixingCommit?.commit || "no-fix";
  const origin = commits.length ? commits.join("+") : candidate.merge?.commit || candidate.caseId;
  return `${candidate.repository}|${fixingCommit}|${origin}`;
}

function normalizeState(state) {
  if (!state) return { outcome: "unavailable", observable: null };
  const outcome = OUTCOMES.has(state.outcome) ? state.outcome : "unavailable";
  return { ...state, outcome, observable: typeof state.observable === "boolean" ? state.observable : null };
}

export function normalizeReplayEvidence(evidence = {}) {
  const states = evidence.states || {};
  return {
    ...evidence,
    states: {
      base: normalizeState(states.base),
      a: normalizeState(states.a),
      b: normalizeState(states.b),
      combined: normalizeState(states.combined),
      fixed: normalizeState(states.fixed),
    },
    issueReports: uniqueBy((evidence.issueReports || []).filter((item) => isoTime(item.reportedAt) !== null), (item) => `${item.number || item.url}|${item.reportedAt}`),
    causes: uniqueBy((evidence.causes || []).filter((item) => isoTime(item.createdAt) !== null), (item) => `${item.number || item.id || item.url}|${item.createdAt}`),
  };
}

export function issuePredatesCauses(evidence) {
  const matchingIssues = evidence.issueReports.filter((item) => item.symptomMatches !== false && item.explicitlyLinked !== false);
  const causeTimes = evidence.causes.map((item) => isoTime(item.createdAt)).filter((item) => item !== null);
  if (!matchingIssues.length || causeTimes.length < 2) return null;
  const earliestIssue = Math.min(...matchingIssues.map((item) => isoTime(item.reportedAt)));
  const earliestCause = Math.min(...causeTimes);
  return earliestIssue < earliestCause;
}

const passes = (state) => state.outcome === "pass";
const fails = (state) => state.outcome === "fail";
const applicableOrPass = (state) => passes(state) || state.outcome === "not-applicable";

export function classifyReplay(rawEvidence = {}) {
  const evidence = normalizeReplayEvidence(rawEvidence);
  const { base, a, b, combined, fixed } = evidence.states;
  const predates = issuePredatesCauses(evidence);
  const independentPair = evidence.pairScope === "independent-prs";
  let classification;
  let reason;

  if (predates === true) {
    classification = "pre-existing-defect";
    reason = "matching-issue-predates-both-causes";
  } else if (fails(base) && base.observable === true) {
    classification = "pre-existing-defect";
    reason = "observable-failure-reproduces-on-base";
  } else if (applicableOrPass(base) && fails(a) && passes(b) && fails(combined) && passes(fixed)) {
    classification = "single-parent-a-bug";
    reason = "a-alone-and-combined-fail";
  } else if (applicableOrPass(base) && passes(a) && fails(b) && fails(combined) && passes(fixed)) {
    classification = "single-parent-b-bug";
    reason = "b-alone-and-combined-fail";
  } else if (applicableOrPass(base) && passes(a) && passes(b) && fails(combined) && passes(fixed)) {
    classification = "pair-induced-conflict";
    reason = "pass-pass-fail-pass-counterfactual";
  } else if (passes(base) && passes(a) && passes(b) && passes(combined)) {
    classification = "compatible";
    reason = "all-counterfactual-states-pass";
  } else if (fails(base) && base.observable !== true) {
    classification = "insufficient";
    reason = "base-logic-fails-but-user-reachability-unproven";
  } else {
    classification = "insufficient";
    reason = "counterfactual-matrix-incomplete-or-ambiguous";
  }

  const pairRelationship = classification === "pair-induced-conflict" ? "conflict"
    : classification === "insufficient" ? "insufficient" : "compatible";
  const pairBenchmarkEligible = independentPair && ["pair-induced-conflict", "compatible"].includes(classification);
  return {
    classification,
    reason,
    pairRelationship,
    pairBenchmarkEligible,
    historyMinerControl: ["pre-existing-defect", "single-parent-a-bug", "single-parent-b-bug"].includes(classification),
    issuePredatesCauses: predates,
    evidence,
  };
}

function representativeRank(candidate) {
  const lineage = candidate.evidence?.lineage?.strength === "both-parent-lineage" ? 0 : 1;
  const distance = Math.abs(Number(candidate.fixingCommit?.epoch || 0) - Number(candidate.merge?.epoch || 0));
  return [lineage, distance, candidate.caseId];
}

function compareRank(left, right) {
  const a = representativeRank(left);
  const b = representativeRank(right);
  return a[0] - b[0] || a[1] - b[1] || String(a[2]).localeCompare(String(b[2]));
}

export function buildCandidateFamilies(candidates = []) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = candidateFamilyKey(candidate);
    const values = groups.get(key) || [];
    values.push(candidate);
    groups.set(key, values);
  }
  return [...groups.entries()].map(([familyKey, members]) => {
    const sorted = [...members].sort(compareRank);
    return {
      schemaVersion: "replay-family-v0.1",
      familyKey,
      representative: sorted[0],
      aliases: sorted.slice(1).map((item) => item.caseId),
      memberCount: sorted.length,
    };
  }).sort((left, right) => left.representative.caseId.localeCompare(right.representative.caseId));
}

export function filterReplayFamilies(candidates, replayEvidence = []) {
  const families = buildCandidateFamilies(candidates);
  const byFamily = new Map();
  const byCase = new Map();
  const append = (map, key, evidence) => {
    if (!key) return;
    const values = map.get(key) || [];
    values.push(evidence);
    map.set(key, values);
  };
  for (const evidence of replayEvidence) {
    append(byFamily, evidence.familyKey, evidence);
    for (const caseId of evidence.caseIds || (evidence.caseId ? [evidence.caseId] : [])) append(byCase, caseId, evidence);
  }
  return families.map((family) => {
    const matching = unique([
      ...(byFamily.get(family.familyKey) || []),
      ...(byCase.get(family.representative.caseId) || []),
      ...family.aliases.flatMap((caseId) => byCase.get(caseId) || []),
    ]);
    const evidence = matching.reduce((combined, item) => ({
      ...combined,
      ...item,
      pairScope: item.pairScope && item.pairScope !== "unknown" ? item.pairScope : combined.pairScope,
      states: { ...(combined.states || {}), ...(item.states || {}) },
      causes: unique([...(combined.causes || []), ...(item.causes || [])]),
      issueReports: unique([...(combined.issueReports || []), ...(item.issueReports || [])]),
      sources: unique([...(combined.sources || []), ...(item.sources || []), item.source]),
    }), {});
    return { ...family, decision: classifyReplay(evidence) };
  });
}
