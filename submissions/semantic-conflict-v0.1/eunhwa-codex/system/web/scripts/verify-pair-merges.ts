import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalysisResult, Candidate, Conflict, PairTextConflict, VerificationFinding } from "../app/lib/analyzer.ts";
import { generateFileOverlapCandidates } from "../app/lib/pair-merge.ts";

type ScanResult = AnalysisResult & { repository: string };
type ScanArtifact = { results: ScanResult[]; [key: string]: unknown };

const [source] = process.argv.slice(2);
if (!source) throw new Error("Usage: verify-pair-merges <artifact.json>");
const artifact = JSON.parse(fs.readFileSync(source, "utf8")) as ScanArtifact;

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function git(cwd: string, args: string[], allowConflict = false, extraEnv: NodeJS.ProcessEnv = {}, input?: string) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...extraEnv, GIT_AUTHOR_NAME: "Contract Radar", GIT_AUTHOR_EMAIL: "contract-radar@localhost", GIT_COMMITTER_NAME: "Contract Radar", GIT_COMMITTER_EMAIL: "contract-radar@localhost" },
    input,
  });
  if (result.status === 0 || (allowConflict && result.status === 1)) return result;
  throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).slice(0, 1000)}`);
}

function gitAsync(cwd: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => resolve({ status: -1, stdout: "", stderr: error.message }));
    child.on("close", (status) => resolve({ status: status ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

for (const result of artifact.results) {
  if (result.pairMergeVerifiedAt && process.env.FORCE_PAIR_VERIFY !== "1") {
    console.log(`Skipping verified ${result.repository}`);
    continue;
  }
  const pending = (result.needsVerification ?? []).filter((finding) => finding.reasonCode === "pair_merge_required");
  const semanticByPair = new Map(pending.map((finding) => [pairKey(finding.a, finding.b), finding]));
  const pairMergeCards = result.pairMergeCards ?? result.cards;
  if (pairMergeCards.length < 2) continue;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.repository)) throw new Error(`Invalid repository: ${result.repository}`);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "contract-radar-pair-"));
  try {
    git(temp, ["init", "-q"]);
    git(temp, ["remote", "add", "origin", `https://github.com/${result.repository}.git`]);
    const prNumbers = [...new Set(pairMergeCards.map((card) => card.pr))];
    const remoteRefs = prNumbers.map((pr) => `refs/pull/${pr}/merge`);
    const advertised = git(temp, ["ls-remote", "--refs", "origin", ...remoteRefs]).stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[1])
      .filter(Boolean);
    const availableRefs = new Set(advertised);
    const availablePrs = prNumbers.filter((pr) => availableRefs.has(`refs/pull/${pr}/merge`));
    const refspecs = availablePrs.map((pr) => `+refs/pull/${pr}/merge:refs/heads/merge-${pr}`);
    if (refspecs.length === 0) continue;
    const remoteHead = git(temp, ["ls-remote", "--symref", "origin", "HEAD"]).stdout;
    const defaultRef = remoteHead.match(/^ref:\s+(refs\/heads\/[^\s]+)\s+HEAD/m)?.[1];
    if (!defaultRef) throw new Error(`Could not resolve default branch for ${result.repository}`);
    git(temp, ["fetch", "-q", "--no-tags", "--filter=blob:none", "--depth=2", "origin", `+${defaultRef}:refs/heads/base-current`, ...refspecs]);
    const currentBase = git(temp, ["rev-parse", "base-current"]).stdout.trim();
    const cards = new Map(pairMergeCards.map((card) => [card.pr, card]));
    const stale = new Set(prNumbers.filter((pr) => !availablePrs.includes(pr)));
    const fetchedBases = new Map<number, string>();
    for (const pr of availablePrs) {
      const card = cards.get(pr);
      if (!card) continue;
      const fetchedBase = git(temp, ["rev-parse", `merge-${pr}^1`]).stdout.trim();
      const fetchedHead = git(temp, ["rev-parse", `merge-${pr}^2`]).stdout.trim();
      fetchedBases.set(pr, fetchedBase);
      card.pairMergeBaseSha = currentBase;
      // Base branches are expected to advance during a full-repository scan.
      // GitHub's synthetic merge ref rebases the frozen PR head onto the base
      // used for this pair check. A changed PR head, however, invalidates the
      // diff-derived file/resource evidence and must be skipped.
      if (card.headSha && card.headSha !== fetchedHead) {
        stale.add(pr);
        continue;
      }
      // The PR head may be far behind the current base. Comparing base→head
      // would misclassify every upstream change since the branch fork as a PR
      // change. GitHub's synthetic merge result isolates the applied PR delta.
      card.files = git(temp, ["diff", "--no-renames", "--name-only", "-z", fetchedBase, `merge-${pr}`]).stdout.split("\0").filter(Boolean).sort();
    }
    let verifiedPairMergeCards = pairMergeCards.filter((card) => !stale.has(card.pr) && fetchedBases.has(card.pr));
    result.pairTextConflicts = [];
    result.pairMergeErrors = [];

    const pairCandidates = new Map<string, Candidate>();
    for (const candidate of generateFileOverlapCandidates(verifiedPairMergeCards)) pairCandidates.set(pairKey(candidate.a, candidate.b), candidate);
    for (const finding of pending) {
      const key = pairKey(finding.a, finding.b);
      const overlap = pairCandidates.get(key);
      pairCandidates.set(key, {
        ...finding,
        sharedResources: [...new Set([...(overlap?.sharedResources ?? []), ...finding.sharedResources])].sort(),
        joinReasons: [...new Set([...(overlap?.joinReasons ?? []), ...(finding.joinReasons ?? [])])].sort(),
      });
    }

    // GitHub synthetic merge refs are refreshed at different times and may not
    // share a base SHA. Replay each exact PR delta (synthetic base → synthetic
    // merge result) onto one current base before pair merging.
    const neededPrs = new Set([...pairCandidates.values()].flatMap((pair) => [pair.a, pair.b]));
    const replayed = new Map<number, string>();
    for (const pr of [...neededPrs].sort((a, b) => a - b)) {
      if (stale.has(pr) || !fetchedBases.has(pr)) continue;
      const index = path.join(temp, `index-${pr}`);
      fs.rmSync(index, { force: true });
      const env = { GIT_INDEX_FILE: index };
      git(temp, ["read-tree", currentBase], false, env);
      const patch = git(temp, ["diff", "--binary", "--full-index", fetchedBases.get(pr)!, `merge-${pr}`]).stdout;
      if (!patch.trim()) {
        stale.add(pr);
        result.pairMergeErrors.push({ a: pr, b: pr, reason: "GitHub synthetic merge contains no replayable PR delta on its recorded base" });
        continue;
      }
      const applied = git(temp, ["apply", "--cached", "--3way", "-"], true, env, patch);
      if (applied.status !== 0) {
        stale.add(pr);
        result.pairMergeErrors.push({ a: pr, b: pr, reason: `Could not replay PR delta on current base: ${(applied.stderr || applied.stdout).slice(0, 1000)}` });
        continue;
      }
      const tree = git(temp, ["write-tree"], false, env).stdout.trim();
      const commit = git(temp, ["commit-tree", tree, "-p", currentBase, "-m", `Replay PR ${pr}`]).stdout.trim();
      replayed.set(pr, commit);
    }
    verifiedPairMergeCards = verifiedPairMergeCards.filter((card) => !neededPrs.has(card.pr) || replayed.has(card.pr));
    result.pairMergeCards = verifiedPairMergeCards;
    result.pairMergePrs = verifiedPairMergeCards.length;
    result.pairMergeUnavailablePrs = pairMergeCards.length - verifiedPairMergeCards.length;

    const verifiableCandidates = [...pairCandidates.values()].filter((finding) =>
      !stale.has(finding.a)
      && !stale.has(finding.b)
      && replayed.has(finding.a)
      && replayed.has(finding.b));
    const outcomes = await mapConcurrent(verifiableCandidates, 4, async (finding) => ({
      finding,
      merged: await gitAsync(temp, ["merge-tree", "--write-tree", replayed.get(finding.a)!, replayed.get(finding.b)!]),
    }));

    for (const { finding, merged } of outcomes) {
      const output = `${merged.stdout}\n${merged.stderr}`;
      const key = pairKey(finding.a, finding.b);
      if (merged.status === 1 && /CONFLICT \(/.test(output)) {
        const conflictLines = output.split("\n").filter((line) => line.includes("CONFLICT (")).map((line) => line.trim());
        const conflictResources = conflictLines
          .map((line) => line.match(/ in (.+)$/)?.[1])
          .filter((file): file is string => Boolean(file))
          .map((file) => `file:${file}`);
        const textConflict: PairTextConflict = {
          ...finding,
          sharedResources: conflictResources.length > 0 ? [...new Set(conflictResources)].sort() : finding.sharedResources,
          verdict: "text_conflict",
          rationale: `두 PR은 각각 base에 병합 가능하지만 함께 적용하면 Git 텍스트 충돌이 발생합니다: ${conflictLines.join("; ")}`,
          evidence: conflictLines,
          verifiedAt: new Date().toISOString(),
        };
        result.pairTextConflicts.push(textConflict);
        result.candidates = result.candidates.filter((pair) => pairKey(pair.a, pair.b) !== key);
        result.conflicts = result.conflicts.filter((pair) => pairKey(pair.a, pair.b) !== key);
        result.needsVerification = (result.needsVerification ?? []).filter((pair) => pairKey(pair.a, pair.b) !== key);
        continue;
      }
      if (merged.status !== 0) {
        result.pairMergeErrors.push({ a: finding.a, b: finding.b, reason: output.trim().slice(0, 1000) || `git merge-tree exited ${merged.status}` });
        continue;
      }

      const semanticFinding = semanticByPair.get(key);
      if (!semanticFinding) continue;
      if (semanticFinding.evidenceStrength === "strong" && semanticFinding.sharedResources.some((resource) => resource.startsWith("api:"))) {
        const conflict: Conflict = {
          ...semanticFinding,
          verdict: "semantic_conflict",
          confidence: 1,
          evidenceLevel: "static_proof",
          rationale: `${semanticFinding.rationale} Pair-level git merge is text-clean, so the remaining strict API mismatch is semantic.`,
        };
        result.conflicts = [...result.conflicts.filter((pair) => pairKey(pair.a, pair.b) !== key), conflict];
        result.needsVerification = (result.needsVerification ?? []).filter((pair) => pairKey(pair.a, pair.b) !== key);
      } else {
        const runtimeFinding: VerificationFinding = { ...semanticFinding, reasonCode: "runtime_contract", rationale: `${semanticFinding.rationale} Pair-level git merge is text-clean; runtime verification remains.` };
        result.needsVerification = (result.needsVerification ?? []).map((pair) => pairKey(pair.a, pair.b) === key ? runtimeFinding : pair);
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  result.pairMergeVerifiedAt = new Date().toISOString();
  fs.writeFileSync(source, JSON.stringify(artifact, null, 2));
  console.log(`Verified ${result.repository}: ${result.pairMergePrs} PRs, ${result.pairTextConflicts?.length ?? 0} text conflicts, ${result.pairMergeErrors?.length ?? 0} errors`);
}

fs.writeFileSync(source, JSON.stringify(artifact, null, 2));
console.log(`Verified pair merges → ${source}`);
