import { execFile } from "node:child_process";
import { parseMergeTreeResult } from "./preflight.mjs";
import { changedOldRanges } from "./history-lineage.mjs";

const DAY_MS = 86_400_000;
const FIX_SUBJECT = /(?:^|\b)(?:bug|fix(?:e[ds]|ing)?|regression|revert(?:s|ed)?|restore[ds]?|incorrect|wrong|crash(?:es|ed)?|broken)\b/i;
const NON_SOURCE = /(?:^|\/)(?:docs?|news|tests?|testing|vendor|third_party|node_modules|dist|build)(?:\/|$)|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)|\.(?:lock|md|rst|txt|png|jpe?g|gif|svg|csv|po|pot)$/i;
const SOURCE_EXTENSION = /\.(?:py|pyx|pxd|js|jsx|ts|tsx|java|kt|kts|go|rs|c|cc|cpp|cxx|h|hh|hpp|cs|rb|php|swift|scala|sh|bash|sql|proto|graphql|ya?ml|toml|json)$/i;

function command(program, args, options = {}) {
  return new Promise((done) => {
    execFile(program, args, {
      timeout: options.timeout || 120_000,
      maxBuffer: 24 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    }, (error, stdout = "", stderr = "") => done({ code: error ? Number(error.code) || 1 : 0, stdout, stderr, error }));
  });
}

const lines = (text = "") => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const unique = (values) => [...new Set(values.filter(Boolean))];
const intersection = (left, right) => {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
};

export function isFixSubject(subject = "") {
  return FIX_SUBJECT.test(subject) && !/\b(?:backport|cherry[ -]pick)\b/i.test(subject);
}

export function isSourcePath(path = "") {
  return SOURCE_EXTENSION.test(path) && !NON_SOURCE.test(path);
}

export function mergeFixEvidence(sideAPaths, sideBPaths, fixPaths) {
  const sourceA = unique(sideAPaths.filter(isSourcePath));
  const sourceB = unique(sideBPaths.filter(isSourcePath));
  const sourceFix = unique(fixPaths.filter(isSourcePath));
  const overlapA = intersection(sourceFix, sourceA);
  const overlapB = intersection(sourceFix, sourceB);
  const sharedBySides = intersection(sourceA, sourceB);
  const sharedTouchedByFix = intersection(sourceFix, sharedBySides);
  const strength = overlapA.length && overlapB.length
    ? (sharedTouchedByFix.length ? "shared-source-surface" : "both-side-source-surfaces")
    : "insufficient";
  return { sourceA, sourceB, sourceFix, overlapA, overlapB, sharedBySides, sharedTouchedByFix, strength };
}

export function classifyLineageSides(reachability = []) {
  const sideACommits = unique(reachability.filter((item) => item.inA && !item.inBase && !item.inB).map((item) => item.sha));
  const sideBCommits = unique(reachability.filter((item) => item.inB && !item.inBase && !item.inA).map((item) => item.sha));
  return {
    sideACommits,
    sideBCommits,
    strength: sideACommits.length && sideBCommits.length
      ? "both-parent-lineage"
      : sideACommits.length || sideBCommits.length ? "single-parent-lineage" : "insufficient",
  };
}

async function git(repoDir, args, options) {
  return command("git", ["-c", "gc.auto=0", `--git-dir=${repoDir}`, ...args], options);
}

async function metadata(repoDir, sha) {
  const result = await git(repoDir, ["show", "-s", "--format=%H%x00%P%x00%T%x00%ct%x00%s%x00%b", sha]);
  if (result.code !== 0) return null;
  const [commit, parents = "", tree = "", epoch = "0", subject = "", body = ""] = result.stdout.trim().split("\0");
  return { commit, parents: parents.split(/\s+/).filter(Boolean), tree, epoch: Number(epoch), subject, body, message: `${subject}\n${body}`.trim() };
}

async function changedPaths(repoDir, left, right) {
  const result = await git(repoDir, ["diff", "--name-only", left, right]);
  return result.code === 0 ? lines(result.stdout) : [];
}

async function isAncestor(repoDir, ancestor, descendant) {
  const result = await git(repoDir, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return result.code === 0 ? true : result.code === 1 ? false : null;
}

async function fixingLineage(repoDir, fixParent, fixCommit, base, parentA, parentB, relevantPaths) {
  const diff = await git(repoDir, ["diff", "--unified=0", fixParent, fixCommit]);
  if (diff.code !== 0) return { ranges: [], blamedCommits: [], sideACommits: [], sideBCommits: [], strength: "unavailable" };
  const relevant = new Set(relevantPaths);
  const ranges = changedOldRanges(diff.stdout).filter((range) => relevant.has(range.path)).slice(0, 20);
  const blamed = new Set();
  for (const range of ranges) {
    const blame = await git(repoDir, ["blame", "--porcelain", `-L${range.start},${range.end}`, fixParent, "--", range.path], { timeout: 20_000 });
    if (blame.code !== 0) continue;
    for (const line of lines(blame.stdout)) {
      const match = line.match(/^([0-9a-f]{40,64})\s/);
      if (match) blamed.add(match[1]);
    }
  }
  const reachability = [];
  for (const sha of blamed) {
    const [inBase, inA, inB] = await Promise.all([
      isAncestor(repoDir, sha, base),
      isAncestor(repoDir, sha, parentA),
      isAncestor(repoDir, sha, parentB),
    ]);
    if ([inBase, inA, inB].includes(null)) continue;
    reachability.push({ sha, inBase, inA, inB });
  }
  return { ranges, blamedCommits: [...blamed], reachability, ...classifyLineageSides(reachability) };
}

async function firstParentHistory(repoDir, ref, limit) {
  const result = await git(repoDir, ["log", "--first-parent", `--max-count=${limit}`, "--format=%H%x00%P%x00%T%x00%ct%x00%s%x00%b%x1e", ref]);
  if (result.code !== 0) throw new Error(`cannot read ${ref}: ${result.stderr || result.stdout}`);
  return result.stdout.split("\x1e").map((row) => row.trim()).filter(Boolean).map((row) => {
    const [commit, parents = "", tree = "", epoch = "0", subject = "", body = ""] = row.split("\0");
    return { commit, parents: parents.split(/\s+/).filter(Boolean), tree, epoch: Number(epoch), subject, body, message: `${subject}\n${body}`.trim() };
  });
}

export async function scanMergeHistory({ repository, repoDir, ref = "HEAD", commitLimit = 2000, mergeLimit = 200, fixWindowDays = 45, fixesPerMerge = 20 }) {
  const history = await firstParentHistory(repoDir, ref, commitLimit);
  const position = new Map(history.map((commit, index) => [commit.commit, index]));
  const merges = history.filter((commit) => commit.parents.length === 2).slice(0, mergeLimit);
  const candidates = [];
  const reviewCandidates = [];
  const controls = [];
  const exclusions = [];

  for (const [index, merge] of merges.entries()) {
    const [parentA, parentB] = merge.parents;
    const baseResult = await git(repoDir, ["merge-base", parentA, parentB]);
    if (baseResult.code !== 0) {
      exclusions.push({ mergeCommit: merge.commit, reason: "merge-base-unavailable" });
      continue;
    }
    const base = baseResult.stdout.trim();
    const automatic = parseMergeTreeResult(await git(repoDir, ["merge-tree", "--write-tree", "--name-only", "--messages", parentA, parentB], { timeout: 300_000 }));
    if (automatic.status !== "clean" || !automatic.treeOid) {
      exclusions.push({ mergeCommit: merge.commit, reason: automatic.status, conflictPaths: automatic.conflictPaths });
      continue;
    }
    if (automatic.treeOid !== merge.tree) {
      exclusions.push({ mergeCommit: merge.commit, reason: "recorded-tree-differs-from-automatic", automaticTree: automatic.treeOid, recordedTree: merge.tree });
      continue;
    }
    const [sideAPaths, sideBPaths] = await Promise.all([
      changedPaths(repoDir, base, parentA),
      changedPaths(repoDir, base, parentB),
    ]);
    const mergeIndex = position.get(merge.commit);
    const deadline = merge.epoch * 1000 + fixWindowDays * DAY_MS;
    const later = history.slice(0, mergeIndex)
      .filter((commit) => commit.epoch * 1000 <= deadline && isFixSubject(commit.message))
      .sort((left, right) => left.epoch - right.epoch)
      .slice(0, fixesPerMerge);
    let found = 0;
    for (const fix of later) {
      const fixMeta = fix.parents.length ? fix : await metadata(repoDir, fix.commit);
      if (!fixMeta?.parents?.length) continue;
      const fixPaths = await changedPaths(repoDir, fixMeta.parents[0], fix.commit);
      const evidence = mergeFixEvidence(sideAPaths, sideBPaths, fixPaths);
      if (evidence.strength === "insufficient") continue;
      const lineage = await fixingLineage(
        repoDir, fixMeta.parents[0], fix.commit, base, parentA, parentB,
        unique([...evidence.overlapA, ...evidence.overlapB]),
      );
      if (lineage.strength === "insufficient" || lineage.strength === "unavailable") continue;
      const record = {
        schemaVersion: "merge-history-candidate-v0.1",
        caseId: `${repository}@${merge.commit.slice(0, 12)}-fix-${fix.commit.slice(0, 12)}`,
        repository,
        merge: { ...merge, base, parentA, parentB, automaticTree: automatic.treeOid },
        fixingCommit: fix,
        evidence: { ...evidence, lineage },
        status: lineage.strength === "both-parent-lineage"
          ? "needs-executable-adjudication"
          : "needs-counterfactual-replay",
        productGold: { relationship: null, evidenceGrade: null, rationale: null },
      };
      if (lineage.strength === "both-parent-lineage") candidates.push(record);
      else reviewCandidates.push(record);
      found += 1;
    }
    if (!found && intersection(sideAPaths.filter(isSourcePath), sideBPaths.filter(isSourcePath)).length) {
      controls.push({
        schemaVersion: "merge-history-control-v0.1",
        caseId: `${repository}@${merge.commit.slice(0, 12)}`,
        repository,
        merge: { ...merge, base, parentA, parentB, automaticTree: automatic.treeOid },
        evidence: { sharedSourcePaths: intersection(sideAPaths.filter(isSourcePath), sideBPaths.filter(isSourcePath)) },
        status: "unlabeled-control",
      });
    }
    if ((index + 1) % 25 === 0) process.stderr.write(`merge scan ${index + 1}/${merges.length}\n`);
  }
  return { historyCount: history.length, mergeCount: merges.length, candidates, reviewCandidates, controls, exclusions };
}
