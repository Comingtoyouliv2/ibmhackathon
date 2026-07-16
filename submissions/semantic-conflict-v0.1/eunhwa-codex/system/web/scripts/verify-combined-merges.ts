import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalysisResult, Candidate, IntentCard, PairTextConflict } from "../app/lib/analyzer.ts";
import {
  classifyCombinedRuns,
  failureSignatures,
  type CombinedRun,
  type CombinedVerification,
} from "../app/lib/combined-verifier.ts";

type ScanResult = AnalysisResult & { repository: string };
type ScanArtifact = { results: ScanResult[]; [key: string]: unknown };
type Profile = {
  profile: string;
  image: string;
  prepareCommand: string;
  runCommand: string;
  fallbackRunCommand: string;
  timeoutSeconds: number;
  memory: string;
  cpus: string;
};
type Profiles = { version: number; repositories: Record<string, Profile> };
type ProcessResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: Error };

const [source, profileSource = "config/combined-verification.json"] = process.argv.slice(2);
if (!source) throw new Error("Usage: verify-combined-merges <artifact.json> [profiles.json]");
const artifact = JSON.parse(fs.readFileSync(source, "utf8")) as ScanArtifact;
const profiles = JSON.parse(fs.readFileSync(profileSource, "utf8")) as Profiles;
const maxPairs = Math.max(1, Number(process.env.COMBINED_MAX_PAIRS ?? 10));
const requestedPair = process.env.COMBINED_PAIR?.split(":").map(Number);
const includePending = process.env.COMBINED_INCLUDE_PENDING === "1";

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function processResult(command: string, args: string[], options: Parameters<typeof spawnSync>[2] = {}): ProcessResult {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, ...options });
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error,
  };
}

function git(cwd: string, args: string[], allowed = [0]): ProcessResult {
  const result = processResult("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Contract Radar",
      GIT_AUTHOR_EMAIL: "contract-radar@localhost",
      GIT_COMMITTER_NAME: "Contract Radar",
      GIT_COMMITTER_EMAIL: "contract-radar@localhost",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (!allowed.includes(result.status ?? -1)) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).slice(0, 2000)}`);
  return result;
}

function docker(args: string[], timeoutMs = 120_000): ProcessResult {
  return processResult("docker", args, { timeout: timeoutMs, env: { PATH: process.env.PATH } });
}

function assertDocker(): void {
  const result = docker(["info", "--format", "{{.ServerVersion}}"], 15_000);
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`Docker is required for isolated combined verification: ${(result.stderr || result.stdout).trim()}`);
}

function dockerRun(
  name: string,
  profile: Profile,
  workspace: string,
  storeVolume: string,
  corepackVolume: string,
  command: string,
  network: boolean,
): ProcessResult {
  const args = [
    "run", "--name", name, "--rm",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "512",
    "--memory", profile.memory,
    "--cpus", profile.cpus,
    "--env", "CI=1",
    "--env", "NO_COLOR=1",
    "--env", "HOME=/tmp/home",
    "--env", "XDG_CACHE_HOME=/tmp/cache",
    "--env", "COREPACK_HOME=/corepack",
    "--volume", `${workspace}:/workspace${network ? ":ro" : ""}`,
    "--volume", `${storeVolume}:/pnpm-store`,
    "--volume", `${corepackVolume}:/corepack`,
    "--workdir", "/workspace",
  ];
  if (!network) args.push(
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=1073741824",
  );
  args.push(profile.image, "bash", "-lc", command);
  const result = docker(args, profile.timeoutSeconds * 1000);
  if (result.status === null) docker(["rm", "-f", name], 15_000);
  return result;
}

function combinedRun(
  label: CombinedRun["label"],
  pairId: string,
  profile: Profile,
  workspace: string,
  storeVolume: string,
  corepackVolume: string,
  command: string,
): CombinedRun {
  const started = Date.now();
  const name = `contract-radar-${pairId}-${label}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
  const result = dockerRun(name, profile, workspace, storeVolume, corepackVolume, command, false);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const timedOut = result.status === null && (result.signal === "SIGTERM" || result.error?.message.includes("ETIMEDOUT"));
  const status = timedOut ? "timeout" : result.status === 0 ? "passed" : result.status === null ? "runner_error" : "failed";
  return {
    label,
    status,
    command,
    exitCode: result.status,
    durationMs: Date.now() - started,
    failureSignatures: status === "passed" ? [] : failureSignatures(output),
    output: output.slice(-16_000),
  };
}

function candidatePairs(result: ScanResult): Candidate[] {
  const pairs = new Map<string, Candidate>();
  for (const finding of result.llmFindings ?? []) {
    if (finding.verdict === "llm_conflict" || (includePending && finding.verdict === "llm_uncertain")) pairs.set(pairKey(finding.a, finding.b), finding);
  }
  for (const finding of result.conflicts) pairs.set(pairKey(finding.a, finding.b), finding);
  if (includePending) for (const finding of result.needsVerification ?? []) pairs.set(pairKey(finding.a, finding.b), finding);
  const textConflicts = new Set((result.pairTextConflicts ?? []).map((pair) => pairKey(pair.a, pair.b)));
  return [...pairs.values()]
    .filter((pair) => Boolean(requestedPair) || !textConflicts.has(pairKey(pair.a, pair.b)))
    .filter((pair) => !requestedPair || pairKey(pair.a, pair.b) === pairKey(requestedPair[0], requestedPair[1]))
    .sort((left, right) => left.a - right.a || left.b - right.b)
    .slice(0, maxPairs)
    .map((pair) => ({ a: pair.a, b: pair.b, sharedResources: pair.sharedResources, evidenceStrength: pair.evidenceStrength, joinReasons: pair.joinReasons }));
}

function renderCommand(profile: Profile, candidate: Candidate, cards: Map<number, IntentCard>): string {
  const sharedFiles = candidate.sharedResources.filter((resource) => resource.startsWith("file:")).map((resource) => resource.slice(5));
  const changedFiles = [...new Set([...(cards.get(candidate.a)?.files ?? []), ...(cards.get(candidate.b)?.files ?? [])])];
  const testFiles = [...new Set([...sharedFiles, ...changedFiles].filter((file) => /(?:^|\/)[^/]+\.(?:test|spec)\.[A-Za-z0-9]+$/.test(file)))].sort();
  const template = testFiles.length > 0 ? profile.runCommand : profile.fallbackRunCommand;
  return template
    .replaceAll("{testFiles}", testFiles.map(shellQuote).join(" "))
    .replaceAll("{sharedFiles}", sharedFiles.map(shellQuote).join(" "));
}

assertDocker();
for (const result of artifact.results) {
  const startedAt = new Date().toISOString();
  const candidates = candidatePairs(result);
  const profile = profiles.repositories[result.repository];
  const findings: CombinedVerification[] = [];
  const errors: Array<{ a: number; b: number; reason: string }> = [];
  let skipped = 0;
  if (!profile) {
    result.combinedVerifications = [];
    result.combinedVerificationErrors = candidates.map((pair) => ({ a: pair.a, b: pair.b, reason: "No combined verification profile for repository" }));
    result.combinedVerificationSummary = { candidatePairs: candidates.length, verifiedPairs: 0, conflicts: 0, clean: 0, inconclusive: 0, skipped: candidates.length, startedAt, finishedAt: new Date().toISOString() };
    continue;
  }
  if (candidates.length === 0) {
    result.combinedVerifications = [];
    result.combinedVerificationErrors = [];
    result.combinedVerificationSummary = { candidatePairs: 0, verifiedPairs: 0, conflicts: 0, clean: 0, inconclusive: 0, skipped: 0, startedAt, finishedAt: new Date().toISOString() };
    continue;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.repository)) throw new Error(`Invalid repository: ${result.repository}`);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "contract-radar-combined-"));
  try {
    git(temp, ["init", "-q"]);
    git(temp, ["remote", "add", "origin", `https://github.com/${result.repository}.git`]);
    const prs = [...new Set(candidates.flatMap((pair) => [pair.a, pair.b]))];
    const remoteHead = git(temp, ["ls-remote", "--symref", "origin", "HEAD"]).stdout;
    const defaultRef = remoteHead.match(/^ref:\s+(refs\/heads\/[^\s]+)\s+HEAD/m)?.[1];
    if (!defaultRef) throw new Error(`Could not resolve default branch for ${result.repository}`);
    const refspecs = prs.map((pr) => `+refs/pull/${pr}/merge:refs/heads/merge-${pr}`);
    git(temp, ["fetch", "-q", "--no-tags", "--depth=2", "origin", `+${defaultRef}:refs/heads/base-current`, ...refspecs]);
    const currentBase = git(temp, ["rev-parse", "base-current"]).stdout.trim();
    const cards = new Map((result.pairMergeCards ?? result.cards).map((card) => [card.pr, card]));

    for (const candidate of candidates) {
      const key = pairKey(candidate.a, candidate.b);
      const cardA = cards.get(candidate.a);
      const cardB = cards.get(candidate.b);
      if (!cardA || !cardB) { skipped++; errors.push({ a: candidate.a, b: candidate.b, reason: "Intent card missing" }); continue; }
      const baseA = git(temp, ["rev-parse", `merge-${candidate.a}^1`]).stdout.trim();
      const baseB = git(temp, ["rev-parse", `merge-${candidate.b}^1`]).stdout.trim();
      const headA = git(temp, ["rev-parse", `merge-${candidate.a}^2`]).stdout.trim();
      const headB = git(temp, ["rev-parse", `merge-${candidate.b}^2`]).stdout.trim();
      if ((cardA.headSha && cardA.headSha !== headA) || (cardB.headSha && cardB.headSha !== headB)) {
        skipped++; errors.push({ a: candidate.a, b: candidate.b, reason: "PR head changed after semantic judgment" }); continue;
      }
      const roots = {
        base: path.join(temp, `work-${key}-base`),
        a: path.join(temp, `work-${key}-a`),
        b: path.join(temp, `work-${key}-b`),
        combined: path.join(temp, `work-${key}-combined`),
      };
      for (const dir of [roots.base, roots.a, roots.b]) git(temp, ["worktree", "add", "-q", "--detach", dir, currentBase]);
      const patchA = path.join(temp, `patch-${candidate.a}.diff`);
      const patchB = path.join(temp, `patch-${candidate.b}.diff`);
      fs.writeFileSync(patchA, git(temp, ["diff", "--binary", "--full-index", baseA, `merge-${candidate.a}`]).stdout);
      fs.writeFileSync(patchB, git(temp, ["diff", "--binary", "--full-index", baseB, `merge-${candidate.b}`]).stdout);
      const applyA = git(roots.a, ["apply", "--3way", "--index", patchA], [0, 1]);
      const applyB = git(roots.b, ["apply", "--3way", "--index", patchB], [0, 1]);
      if (applyA.status !== 0 || applyB.status !== 0) {
        skipped++;
        errors.push({ a: candidate.a, b: candidate.b, reason: `Could not replay PR delta on current base: ${(applyA.stderr || applyB.stderr || applyA.stdout || applyB.stdout).slice(0, 1000)}` });
        for (const dir of [roots.base, roots.a, roots.b]) git(temp, ["worktree", "remove", "--force", dir], [0, 128]);
        continue;
      }
      const commitA = git(roots.a, ["commit", "-q", "--allow-empty", "-m", `Replay PR ${candidate.a}`]).status === 0 ? git(roots.a, ["rev-parse", "HEAD"]).stdout.trim() : "";
      const commitB = git(roots.b, ["commit", "-q", "--allow-empty", "-m", `Replay PR ${candidate.b}`]).status === 0 ? git(roots.b, ["rev-parse", "HEAD"]).stdout.trim() : "";
      const tree = git(temp, ["merge-tree", "--write-tree", commitA, commitB], [0, 1]);
      if (tree.status !== 0) {
        const output = `${tree.stdout}\n${tree.stderr}`;
        const conflictLines = output.split("\n").filter((line) => line.includes("CONFLICT (")).map((line) => line.trim());
        const textConflict: PairTextConflict = {
          ...candidate,
          verdict: "text_conflict",
          rationale: `동일한 현재 base에 두 PR delta를 재생한 실제 병합에서 Git 텍스트 충돌이 발생했습니다: ${conflictLines.join("; ")}`,
          evidence: conflictLines.length > 0 ? conflictLines : [output.trim().slice(0, 1000)],
          verifiedAt: new Date().toISOString(),
        };
        result.pairTextConflicts = [...(result.pairTextConflicts ?? []).filter((pair) => pairKey(pair.a, pair.b) !== key), textConflict]
          .sort((left, right) => left.a - right.a || left.b - right.b);
        findings.push({
          ...candidate,
          verdict: "combined_conflict",
          rationale: textConflict.rationale,
          runs: [],
          evidence: textConflict.evidence,
          baseSha: currentBase,
          headShaA: headA,
          headShaB: headB,
          profile: "git-same-base",
          verifiedAt: textConflict.verifiedAt,
        });
        console.log(`${result.repository} #${candidate.a} x #${candidate.b}: text_conflict`);
        for (const dir of [roots.base, roots.a, roots.b]) git(temp, ["worktree", "remove", "--force", dir], [0, 128]);
        continue;
      }
      const treeSha = tree.stdout.trim().split("\n")[0];
      const combinedCommit = git(temp, ["commit-tree", treeSha, "-p", commitA, "-p", commitB, "-m", `Combined PR ${candidate.a} + ${candidate.b}`]).stdout.trim();
      git(temp, ["worktree", "add", "-q", "--detach", roots.combined, combinedCommit]);
      const volumeSuffix = `${process.pid}-${candidate.a}-${candidate.b}`;
      const storeVolume = `contract-radar-store-${volumeSuffix}`;
      const corepackVolume = `contract-radar-corepack-${volumeSuffix}`;
      docker(["volume", "create", storeVolume]);
      docker(["volume", "create", corepackVolume]);
      try {
        const prepareName = `contract-radar-${volumeSuffix}-prepare`;
        const prepared = dockerRun(prepareName, profile, roots.base, storeVolume, corepackVolume, profile.prepareCommand, true);
        const command = renderCommand(profile, candidate, cards);
        let runA: CombinedRun;
        let runB: CombinedRun;
        let combined: CombinedRun;
        let confirmation: CombinedRun | undefined;
        if (prepared.status !== 0) {
          const output = `${prepared.stdout}\n${prepared.stderr}`.trim().slice(-16_000);
          const failed = (label: CombinedRun["label"]): CombinedRun => ({ label, status: "runner_error", command, exitCode: prepared.status, durationMs: 0, failureSignatures: failureSignatures(output), output });
          runA = failed("pr_a"); runB = failed("pr_b"); combined = failed("combined");
        } else {
          runA = combinedRun("pr_a", key, profile, roots.a, storeVolume, corepackVolume, command);
          runB = combinedRun("pr_b", key, profile, roots.b, storeVolume, corepackVolume, command);
          combined = combinedRun("combined", key, profile, roots.combined, storeVolume, corepackVolume, command);
          if (runA.status === "passed" && runB.status === "passed" && combined.status === "failed") {
            confirmation = combinedRun("combined_confirmation", `${key}-confirm`, profile, roots.combined, storeVolume, corepackVolume, command);
          }
        }
        const classification = classifyCombinedRuns(runA, runB, combined, confirmation);
        findings.push({
          ...candidate,
          ...classification,
          runs: [runA, runB, combined, ...(confirmation ? [confirmation] : [])],
          baseSha: currentBase,
          headShaA: headA,
          headShaB: headB,
          profile: profile.profile,
          verifiedAt: new Date().toISOString(),
        });
        console.log(`${result.repository} #${candidate.a} x #${candidate.b}: ${classification.verdict}`);
      } finally {
        docker(["volume", "rm", "-f", storeVolume, corepackVolume], 30_000);
        for (const dir of [roots.base, roots.a, roots.b, roots.combined]) git(temp, ["worktree", "remove", "--force", dir], [0, 128]);
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  result.combinedVerifications = findings;
  result.combinedVerificationErrors = errors;
  result.combinedVerificationSummary = {
    candidatePairs: candidates.length,
    verifiedPairs: findings.length,
    conflicts: findings.filter((finding) => finding.verdict === "combined_conflict").length,
    clean: findings.filter((finding) => finding.verdict === "combined_clean").length,
    inconclusive: findings.filter((finding) => finding.verdict === "combined_inconclusive").length,
    skipped,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(source, JSON.stringify(artifact, null, 2));
}

fs.writeFileSync(source, JSON.stringify(artifact, null, 2));
console.log(`Combined verification complete → ${source}`);
