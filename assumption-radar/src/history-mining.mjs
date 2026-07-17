import { createHash } from "node:crypto";
import { languageForFile } from "./adapters/registry.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIX_TITLE_PATTERN = /^(?:\s*(?:BUG|FIX|REGR|REGRESSION|REVERT)\b)|\b(?:fix(?:e[ds]|ing)?|regression|revert(?:s|ed)?|restore[ds]?|incorrect|wrong|crash(?:es|ed)?|segfault|broken)\b/i;
const STRONG_FIX_BODY_PATTERN = /\b(?:regression|regressed|introduced\s+by|caused\s+by|broken\s+by|broke\s+after|revert(?:s|ed|ing)?)\b|\bafter\s+#\d+\b/i;
const BACKPORT_PATTERN = /(?:^|\b)(?:backport|cherry[ -]pick(?:ed)?)(?:\b|$)/i;
const TEST_PATH = /(?:^|\/)(?:tests?|testing)(?:\/|$)|(?:^|\/)test_[^/]+\.py$/i;

const unique = (values) => [...new Set(values.filter(Boolean))];
const codePath = (filename) => !/(?:^|\/)(?:docs?|news|doc\/whats_new)(?:\/|$)|\.(?:md|rst|png|jpe?g|gif|svg)$/i.test(filename);
const daysBetween = (left, right) => Math.abs(new Date(left) - new Date(right)) / DAY_MS;

export function referencedPullRequests(pr) {
  return unique([...`${pr.title || ""}\n${pr.body || ""}`.matchAll(/(?:^|[^\w])#(\d{2,7})\b/g)].map((match) => Number(match[1])));
}

export function isLikelyFix(pr) {
  const text = `${pr.title || ""}\n${pr.body || ""}`;
  if (BACKPORT_PATTERN.test(text)) return false;
  return FIX_TITLE_PATTERN.test(pr.title || "") || STRONG_FIX_BODY_PATTERN.test(pr.body || "");
}

export function touchesLanguage(pr, language) {
  return !language || pr.files.some((file) => languageForFile(file.filename) === language);
}

function changedCodePaths(pr) {
  return unique(pr.files.map((file) => file.filename).filter(codePath));
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function patchHunks(patch = "") {
  return patch.split(/(?=^@@)/m).filter((part) => part.startsWith("@@")).map((part) => ({
    section: (part.match(/^@@[^@]*@@\s*(.*)$/m) || [])[1]?.trim() || "",
    changedLines: part.split("\n").slice(1)
      .filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---)/.test(line))
      .map((line) => line.slice(1).trim().replace(/\s+/g, " "))
      .filter((line) => line.length >= 8 && !/^[{}()[\],.;:+*=<>-]+$/.test(line)
        && !/^(?:import|from)\s/.test(line)),
  }));
}

function sameSection(left, right) {
  if (!left || !right || left.length < 4 || right.length < 4) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function sourceSurfaces(pr, fix) {
  const surfaces = [];
  for (const fixFile of fix.files.filter((file) => codePath(file.filename) && !TEST_PATH.test(file.filename))) {
    const priorFile = pr.files.find((file) => file.filename === fixFile.filename);
    if (!priorFile) continue;
    for (const priorHunk of patchHunks(priorFile.patch)) {
      for (const fixHunk of patchHunks(fixFile.patch)) {
        const fixLines = new Set(fixHunk.changedLines);
        const sharedChangedLines = priorHunk.changedLines.filter((line) => fixLines.has(line));
        const declarationMatch = sameSection(priorHunk.section, fixHunk.section);
        if (!declarationMatch && !sharedChangedLines.length) continue;
        surfaces.push({
          file: fixFile.filename,
          priorSection: priorHunk.section || null,
          fixSection: fixHunk.section || null,
          declarationMatch,
          sharedChangedLines,
        });
      }
    }
  }
  return surfaces;
}

function stableHash(value) {
  return createHash("sha1").update(value).digest("hex");
}

function compactPr(pr) {
  return {
    number: pr.number, title: pr.title, url: pr.url, author: pr.author,
    mergedAt: pr.mergedAt, headSha: pr.headSha, baseSha: pr.baseSha,
    mergeCommitSha: pr.mergeCommitSha, base: pr.base,
    files: changedCodePaths(pr),
  };
}

function priorMatches(fix, merged, fixWindowDays) {
  const fixPaths = changedCodePaths(fix);
  const explicit = new Set(referencedPullRequests(fix));
  return merged
    .filter((pr) => pr.number !== fix.number && pr.base === fix.base && new Date(pr.mergedAt) < new Date(fix.mergedAt))
    .filter((pr) => daysBetween(pr.mergedAt, fix.mergedAt) <= fixWindowDays)
    .map((pr) => {
      const sharedWithFix = intersection(changedCodePaths(pr), fixPaths);
      const explicitlyReferenced = explicit.has(pr.number);
      const testOverlap = sharedWithFix.filter((path) => TEST_PATH.test(path));
      const sourceOverlap = sharedWithFix.filter((path) => !TEST_PATH.test(path));
      const surfaces = sourceSurfaces(pr, fix);
      return { pr, sharedWithFix, explicitlyReferenced, testOverlap, sourceOverlap, surfaces };
    })
    .filter((item) => item.sharedWithFix.length || item.explicitlyReferenced)
    .sort((a, b) => Number(b.explicitlyReferenced) - Number(a.explicitlyReferenced)
      || b.sourceOverlap.length - a.sourceOverlap.length
      || b.testOverlap.length - a.testOverlap.length
      || daysBetween(a.pr.mergedAt, fix.mergedAt) - daysBetween(b.pr.mergedAt, fix.mergedAt))
    .slice(0, 12);
}

function candidateRecord(repository, fix, left, right) {
  const pair = [left, right].sort((a, b) => a.pr.number - b.pr.number);
  const [a, b] = pair;
  const explicitRefs = referencedPullRequests(fix);
  const sharedBetweenCauses = intersection(changedCodePaths(a.pr), changedCodePaths(b.pr));
  const evidence = {
    fixReferences: explicitRefs.filter((number) => number === a.pr.number || number === b.pr.number),
    fixFilesTouchedByA: a.sharedWithFix,
    fixFilesTouchedByB: b.sharedWithFix,
    filesSharedByAAndB: sharedBetweenCauses,
    daysAToFix: Number(daysBetween(a.pr.mergedAt, fix.mergedAt).toFixed(1)),
    daysBToFix: Number(daysBetween(b.pr.mergedAt, fix.mergedAt).toFixed(1)),
    daysBetweenAAndB: Number(daysBetween(a.pr.mergedAt, b.pr.mergedAt).toFixed(1)),
    sourceSurfacesA: a.surfaces,
    sourceSurfacesB: b.surfaces,
  };
  const rankingSignals = [
    ...(a.explicitlyReferenced ? ["fix-explicitly-references-a"] : []),
    ...(b.explicitlyReferenced ? ["fix-explicitly-references-b"] : []),
    ...(a.sourceOverlap.length ? ["a-shares-source-with-fix"] : []),
    ...(b.sourceOverlap.length ? ["b-shares-source-with-fix"] : []),
    ...(sharedBetweenCauses.length ? ["causes-share-file"] : []),
    ...(a.testOverlap.length || b.testOverlap.length ? ["fix-test-overlap"] : []),
    ...(a.surfaces.length ? ["a-shares-fix-source-surface"] : []),
    ...(b.surfaces.length ? ["b-shares-fix-source-surface"] : []),
  ];
  return {
    caseId: `${repository}#${a.pr.number}x${b.pr.number}-fix-${fix.number}`,
    repository,
    queueReason: "history-fix-anchor",
    candidateKind: "possible-pair-regression",
    causes: [compactPr(a.pr), compactPr(b.pr)],
    fixingPullRequest: compactPr(fix),
    rankingSignals,
    evidence,
    label: {
      status: "unlabeled", relationship: null, mechanicalMerge: null,
      evidenceGrade: null, fixingCommitCausal: null, notes: "",
    },
  };
}

function candidateRank(candidate) {
  const signals = new Set(candidate.rankingSignals);
  return (signals.has("fix-explicitly-references-a") ? 8 : 0)
    + (signals.has("fix-explicitly-references-b") ? 8 : 0)
    + (signals.has("a-shares-source-with-fix") ? 3 : 0)
    + (signals.has("b-shares-source-with-fix") ? 3 : 0)
    + (signals.has("causes-share-file") ? 2 : 0)
    + (signals.has("fix-test-overlap") ? 1 : 0)
    + (signals.has("a-shares-fix-source-surface") ? 8 : 0)
    + (signals.has("b-shares-fix-source-surface") ? 8 : 0);
}

function causallySupportedPair(left, right) {
  const explicitCount = Number(left.explicitlyReferenced) + Number(right.explicitlyReferenced);
  if (explicitCount === 2) return true;
  return left.surfaces.length > 0 && right.surfaces.length > 0;
}

function controlRecords(repository, merged, candidatePairKeys, count) {
  const byFile = new Map();
  for (const pr of merged) {
    for (const path of changedCodePaths(pr)) {
      const items = byFile.get(path) || [];
      items.push(pr);
      byFile.set(path, items);
    }
  }
  const controls = new Map();
  for (const [path, prs] of byFile) {
    for (let i = 0; i < prs.length; i += 1) {
      for (let j = i + 1; j < prs.length; j += 1) {
        const pair = [prs[i], prs[j]].sort((a, b) => a.number - b.number);
        if (daysBetween(pair[0].mergedAt, pair[1].mergedAt) > 90) continue;
        const key = `${pair[0].number}x${pair[1].number}`;
        if (candidatePairKeys.has(key)) continue;
        const current = controls.get(key) || { pair, sharedFiles: [] };
        current.sharedFiles.push(path);
        controls.set(key, current);
      }
    }
  }
  return [...controls.entries()]
    .sort((a, b) => b[1].sharedFiles.length - a[1].sharedFiles.length || stableHash(a[0]).localeCompare(stableHash(b[0])))
    .slice(0, count)
    .map(([key, item]) => ({
      caseId: `${repository}#${key}`,
      repository,
      queueReason: "history-matched-control",
      candidateKind: "same-file-control",
      causes: item.pair.map(compactPr),
      fixingPullRequest: null,
      rankingSignals: ["same-file", "nearby-merge-time"],
      evidence: { filesSharedByAAndB: unique(item.sharedFiles), daysBetweenAAndB: Number(daysBetween(item.pair[0].mergedAt, item.pair[1].mergedAt).toFixed(1)) },
      label: { status: "unlabeled", relationship: null, mechanicalMerge: null, evidenceGrade: null, fixingCommitCausal: null, notes: "" },
    }));
}

export function mineHistoryCandidates(repository, merged, options = {}) {
  const fixWindowDays = Number(options.fixWindowDays) || 90;
  const candidateLimit = Number(options.candidateLimit) || 30;
  const controlCount = Number(options.controlCount) || 20;
  const perFixLimit = Number(options.perFixLimit) || 3;
  const fixes = merged.filter(isLikelyFix);
  const candidates = [];
  for (const fix of fixes) {
    const priors = priorMatches(fix, merged, fixWindowDays);
    const fixCandidates = [];
    for (let i = 0; i < priors.length; i += 1) {
      for (let j = i + 1; j < priors.length; j += 1) {
        if (causallySupportedPair(priors[i], priors[j])) fixCandidates.push(candidateRecord(repository, fix, priors[i], priors[j]));
      }
    }
    candidates.push(...fixCandidates.sort((a, b) => candidateRank(b) - candidateRank(a)
      || a.caseId.localeCompare(b.caseId)).slice(0, perFixLimit));
  }
  const uniqueCandidates = [...new Map(candidates.map((item) => [item.caseId, item])).values()]
    .sort((a, b) => candidateRank(b) - candidateRank(a) || a.caseId.localeCompare(b.caseId))
    .slice(0, candidateLimit);
  const pairKeys = new Set(uniqueCandidates.map((item) => item.causes.map((pr) => pr.number).sort((a, b) => a - b).join("x")));
  // Fix anchors are not neutral controls: pairing a fixing PR with one of its
  // possible causes would contaminate the negative queue with the very signal
  // used for positive discovery.
  const fixNumbers = new Set(fixes.map((fix) => fix.number));
  const controlPool = merged.filter((pr) => !fixNumbers.has(pr.number));
  const controls = controlRecords(repository, controlPool, pairKeys, controlCount);
  return { fixes, candidates: uniqueCandidates, controls, queue: [...uniqueCandidates, ...controls] };
}
