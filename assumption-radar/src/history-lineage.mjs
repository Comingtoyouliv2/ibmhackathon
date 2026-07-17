import { execFile } from "node:child_process";

const TEST_PATH = /(?:^|\/)(?:tests?|testing)(?:\/|$)|(?:^|\/)test_[^/]+\.py$/i;
const NON_SOURCE_PATH = /(?:^|\/)(?:docs?|news|doc\/source\/whatsnew|vendor|third_party|node_modules)(?:\/|$)|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)|\.(?:lock|md|rst|png|jpe?g|gif|svg)$/i;
const PR_SUBJECT = /\(#(\d+)\)\s*$/;

function command(program, args, options = {}) {
  return new Promise((done) => {
    execFile(program, args, {
      timeout: options.timeout || 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    }, (error, stdout = "", stderr = "") => done({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
  });
}

export function changedOldRanges(diff = "") {
  const ranges = [];
  let path = null;
  for (const line of diff.split(/\r?\n/)) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) { path = header[1]; continue; }
    const hunk = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+\d+(?:,\d+)?\s+@@/);
    if (!path || !hunk || TEST_PATH.test(path) || NON_SOURCE_PATH.test(path)) continue;
    const start = Number(hunk[1]);
    const count = Number(hunk[2] ?? 1);
    ranges.push({ path, start: Math.max(1, start), end: Math.max(1, start + Math.max(1, Math.min(count, 20)) - 1) });
  }
  return ranges;
}

export function pullNumberFromSubject(subject = "") {
  const match = subject.match(PR_SUBJECT);
  return match ? Number(match[1]) : null;
}

async function git(repoDir, args, options) {
  return command("git", ["-c", "gc.auto=0", `--git-dir=${repoDir}`, ...args], options);
}

async function commitSubject(repoDir, sha) {
  const result = await git(repoDir, ["show", "-s", "--format=%s", sha]);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function blamedCommits(repoDir, parent, range, since) {
  const result = await git(repoDir, ["blame", "--first-parent", `--since=${since}`, "--porcelain", `-L${range.start},${range.end}`, parent, "--", range.path], { timeout: 15_000 });
  if (result.code !== 0) return [];
  const blamed = [...new Set(result.stdout.split(/\r?\n/)
    // A leading ^ is a --since boundary marker, not proof that the boundary
    // commit introduced this line. Treating it as a culprit creates arbitrary
    // old-commit pairs.
    .map((line) => line.match(/^([0-9a-f]{40})\s/))
    .filter(Boolean).map((match) => match[1]))];
  const verified = [];
  for (const sha of blamed) {
    const touched = await git(repoDir, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha, "--", range.path]);
    if (touched.code === 0 && touched.stdout.split(/\r?\n/).includes(range.path)) verified.push(sha);
  }
  return verified;
}

async function isAncestor(repoDir, ancestor, descendant) {
  if (!ancestor || !descendant) return null;
  const result = await git(repoDir, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  return null;
}

function compactPull(pr) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    base: pr.base,
    baseSha: pr.baseSha,
    headSha: pr.headSha,
    mergeCommitSha: pr.mergeCommitSha,
    mergedAt: pr.mergedAt,
  };
}

export async function traceFixLineage({ repository, repoDir, fix, referencedNumbers = [], fetchPull, fetchPullsForCommit }) {
  const result = {
    fix: compactPull(fix), ranges: [], blamedCommits: [], blamedPullNumbers: [],
    referencedPullNumbers: [], candidates: [], exclusions: [], errors: [],
  };
  if (!fix.mergeCommitSha) { result.errors.push("missing-fix-merge-commit"); return result; }
  const parentResult = await git(repoDir, ["rev-parse", `${fix.mergeCommitSha}^`]);
  if (parentResult.code !== 0) { result.errors.push("missing-fix-parent"); return result; }
  const parent = parentResult.stdout.trim();
  const diffResult = await git(repoDir, ["diff", "--unified=0", parent, fix.mergeCommitSha]);
  if (diffResult.code !== 0) { result.errors.push("cannot-read-fix-diff"); return result; }
  result.ranges = changedOldRanges(diffResult.stdout);
  const since = new Date(new Date(fix.mergedAt).getTime() - 120 * 86400000).toISOString().slice(0, 10);
  const commitSet = new Set();
  for (const range of result.ranges.slice(0, 20)) {
    for (const sha of await blamedCommits(repoDir, parent, range, since)) commitSet.add(sha);
  }
  result.blamedCommits = [...commitSet];
  const blamedPullNumbers = new Set();
  for (const sha of commitSet) {
    const number = pullNumberFromSubject(await commitSubject(repoDir, sha));
    if (number && number !== fix.number) blamedPullNumbers.add(number);
    else if (fetchPullsForCommit) {
      try {
        const associated = await fetchPullsForCommit(repository, sha);
        for (const pr of associated) if (pr.number !== fix.number) blamedPullNumbers.add(pr.number);
      } catch { /* Association can be unavailable for imported commits. */ }
    }
  }
  result.blamedPullNumbers = [...blamedPullNumbers];

  const pullCache = new Map();
  async function getPull(number) {
    if (!pullCache.has(number)) pullCache.set(number, await fetchPull(repository, number));
    return pullCache.get(number);
  }
  const referencedPulls = [];
  for (const number of referencedNumbers) {
    try {
      const pr = await getPull(number);
      if (pr?.mergedAt && pr.number !== fix.number) referencedPulls.push(pr);
    } catch { /* An issue number is not a pull request. */ }
  }
  result.referencedPullNumbers = referencedPulls.map((pr) => pr.number);
  const blamedPulls = [];
  for (const number of blamedPullNumbers) {
    try {
      const pr = await getPull(number);
      if (pr?.mergedAt) blamedPulls.push(pr);
    } catch { /* Commit subjects can refer to deleted or inaccessible PRs. */ }
  }

  const pairs = new Map();
  for (const blamed of blamedPulls) {
    for (const referenced of referencedPulls) {
      if (blamed.number === referenced.number) continue;
      const pair = [blamed, referenced].sort((a, b) => a.number - b.number);
      pairs.set(`${pair[0].number}x${pair[1].number}`, { pair, basis: "blamed-line-plus-fix-reference" });
    }
  }
  for (let i = 0; i < blamedPulls.length; i += 1) {
    for (let j = i + 1; j < blamedPulls.length; j += 1) {
      const pair = [blamedPulls[i], blamedPulls[j]].sort((a, b) => a.number - b.number);
      pairs.set(`${pair[0].number}x${pair[1].number}`, { pair, basis: "two-fix-lineages" });
    }
  }

  for (const [key, item] of pairs) {
    const [a, b] = item.pair;
    const reasons = [];
    if (a.base !== b.base || a.base !== fix.base) reasons.push("different-base-branch");
    if (new Date(a.mergedAt) >= new Date(fix.mergedAt) || new Date(b.mergedAt) >= new Date(fix.mergedAt)) reasons.push("cause-not-before-fix");
    const aContainedByB = await isAncestor(repoDir, a.mergeCommitSha, b.baseSha);
    const bContainedByA = await isAncestor(repoDir, b.mergeCommitSha, a.baseSha);
    if (aContainedByB || bContainedByA) reasons.push("sequential-not-independent");
    if (aContainedByB === null || bContainedByA === null) reasons.push("ancestry-unavailable");
    const record = {
      caseId: `${repository}#${key}-fix-${fix.number}`,
      repository,
      candidateKind: "lineage-pair-regression",
      causes: item.pair.map(compactPull),
      fixingPullRequest: compactPull(fix),
      discoveryBasis: item.basis,
      ancestry: { aMergeContainedByBBase: aContainedByB, bMergeContainedByABase: bContainedByA },
      status: reasons.length ? "excluded" : "needs-mechanical-verification",
      exclusionReasons: reasons,
    };
    if (reasons.length) result.exclusions.push(record);
    else result.candidates.push(record);
  }
  return result;
}
