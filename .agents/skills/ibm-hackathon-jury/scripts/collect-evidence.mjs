#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(scriptDir, "..");

function parseArgs(argv) {
  const options = { target: "staged", commit: "HEAD", verify: false, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify") options.verify = true;
    else if (arg === "--target") options.target = argv[++index];
    else if (arg === "--commit") options.commit = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeout || 30_000,
    env: process.env,
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error?.message || null,
  };
}

function git(root, args, options = {}) {
  const result = run("git", args, { cwd: root, ...options });
  if (options.allowFailure !== true && result.status !== 0) {
    throw new Error(`${result.command} failed: ${result.stderr || result.error || "unknown error"}`);
  }
  return result;
}

function lines(value) {
  return value ? value.split(/\r?\n/).filter(Boolean) : [];
}

function sha256(parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function truncate(value, max = 16_000) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...[truncated ${value.length - max} characters]`;
}

function findProductDir(root) {
  const preferred = join(root, "assumption-radar", "package.json");
  if (existsSync(preferred)) return dirname(preferred);
  const rootPackage = join(root, "package.json");
  if (existsSync(rootPackage)) return root;
  return null;
}

function targetFiles(root, target, ref) {
  if (target === "commit") {
    return lines(git(root, ["ls-tree", "-r", "--name-only", ref]).stdout);
  }
  const tracked = lines(git(root, ["ls-files", "--cached"]).stdout);
  if (target !== "worktree") return tracked;
  const untracked = lines(git(root, ["ls-files", "--others", "--exclude-standard"]).stdout);
  return [...new Set([...tracked, ...untracked])].sort();
}

function keywordMatches(root, target, ref) {
  const pattern = "IBM Bob|SkillsBuild|Future of Work|user (test|interview)|pilot|deploy|benchmark|precision|recall|latency|cost|ROI";
  let args = ["grep", "-n", "-I", "-i"];
  if (target === "staged") args.push("--cached");
  args.push("-E", pattern);
  if (target === "commit") args.push(ref);
  args.push("--", "README.md", "assumption-radar", "pipeline", "technical-plan.md");
  const result = git(root, args, { allowFailure: true });
  return {
    command: result.command,
    matches: lines(result.stdout).slice(0, 300),
    truncated: lines(result.stdout).length > 300,
  };
}

function mismatchForVerification(root, target, ref, productRelative) {
  if (target === "worktree") return [];
  const trackedArgs = target === "commit"
    ? ["diff", "--name-only", ref, "--", productRelative]
    : ["diff", "--name-only", "--", productRelative];
  const tracked = lines(git(root, trackedArgs).stdout);
  // Verification always runs in the current worktree.  An untracked file can
  // therefore change a test, dynamically loaded module, config, or demo asset
  // without being represented by a staged/commit snapshot.  Treat it as
  // contamination instead of awarding verification evidence to that snapshot.
  const untracked = lines(git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    productRelative,
  ]).stdout);
  return [...new Set([...tracked, ...untracked])].sort();
}

function verifyProduct(root, productDir, target, ref) {
  if (!productDir) {
    return {
      requested: true,
      snapshotMatch: false,
      contamination: ["No package.json-backed product directory was found."],
      runs: [],
    };
  }
  const productRelative = relative(root, productDir) || ".";
  const contamination = mismatchForVerification(root, target, ref, productRelative);
  const commands = [
    ["npm", ["run", "check"]],
    ["npm", ["test"]],
  ];
  const runs = commands.map(([command, args]) => {
    const result = run(command, args, { cwd: productDir, timeout: 180_000 });
    return {
      ...result,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      cwd: productRelative,
      passed: result.status === 0,
    };
  });
  return {
    requested: true,
    executedAgainst: "worktree",
    snapshotMatch: target === "worktree" || contamination.length === 0,
    contamination,
    runs,
  };
}

function changedFiles(root, target, ref) {
  if (target === "staged") return lines(git(root, ["diff", "--cached", "--name-status"]).stdout);
  if (target === "commit") {
    return lines(git(root, ["diff-tree", "--no-commit-id", "--name-status", "-r", ref]).stdout);
  }
  return [
    ...lines(git(root, ["diff", "--name-status", "HEAD"]).stdout),
    ...lines(git(root, ["ls-files", "--others", "--exclude-standard"]).stdout).map((path) => `?\t${path}`),
  ];
}

function snapshot(root, target, commitRef) {
  const head = git(root, ["rev-parse", "HEAD"]).stdout;
  if (target === "staged") {
    const staged = git(root, ["diff", "--cached", "--name-only"]).stdout;
    if (!staged) throw new Error("The index is empty. Stage a snapshot or choose --target commit/worktree.");
    const tree = git(root, ["write-tree"]).stdout;
    return { type: target, id: `index:${tree}`, tree, baseCommit: head, ref: null };
  }
  if (target === "commit") {
    const commit = git(root, ["rev-parse", `${commitRef}^{commit}`]).stdout;
    const tree = git(root, ["rev-parse", `${commit}^{tree}`]).stdout;
    return { type: target, id: `commit:${commit}`, tree, baseCommit: commit, ref: commitRef };
  }
  if (target === "worktree") {
    const diff = git(root, ["diff", "--binary", "HEAD"]).stdout;
    const untracked = lines(git(root, ["ls-files", "--others", "--exclude-standard"]).stdout);
    const untrackedContent = untracked.map((path) => {
      const absolute = join(root, path);
      if (!existsSync(absolute)) return `${path}:missing`;
      const content = readFileSync(absolute);
      return content.length <= 1_000_000 ? Buffer.concat([Buffer.from(path), content]) : Buffer.from(`${path}:${content.length}`);
    });
    const digest = sha256([head, diff, ...untrackedContent]);
    return { type: target, id: `worktree:${digest}`, tree: null, baseCommit: head, ref: null };
  }
  throw new Error(`Unsupported target: ${target}`);
}

function artifactSummary(files) {
  const count = (regex) => files.filter((path) => regex.test(path)).length;
  return {
    totalFiles: files.length,
    readmes: files.filter((path) => /(^|\/)README(?:\.[^/]+)?$/i.test(path)),
    testFileCount: count(/(^|\/)(test|tests|__tests__)\//i),
    documentationFileCount: count(/(^|\/)(docs?|hackathon)\//i),
    workflowFiles: files.filter((path) => path.startsWith(".github/workflows/")),
    demoFiles: files.filter((path) => /(^|\/)(demo|public)\//i.test(path)).slice(0, 100),
    deploymentFiles: files.filter((path) => /(^|\/)(Dockerfile|docker-compose[^/]*|fly\.toml|vercel\.json|render\.yaml|Procfile)$/i.test(path)),
  };
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write("Usage: collect-evidence.mjs --target staged|commit|worktree [--commit REF] --output FILE [--verify]\n");
  process.exit(0);
}
if (!["staged", "commit", "worktree"].includes(options.target)) {
  throw new Error("--target must be staged, commit, or worktree");
}

const rootProbe = run("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
if (rootProbe.status !== 0) throw new Error("Run this command inside a Git repository.");
const root = rootProbe.stdout;
const snap = snapshot(root, options.target, options.commit);
const files = targetFiles(root, options.target, snap.baseCommit);
const productDir = findProductDir(root);
const rubricParts = ["hackathon-brief.md", "scoring-contract.md", "rubric.json"]
  .map((name) => readFileSync(join(skillDir, "references", name)));
const rubricHash = sha256(rubricParts);
const status = git(root, ["status", "--short", "--branch"]).stdout;
const changed = changedFiles(root, options.target, snap.baseCommit);
const verification = options.verify
  ? verifyProduct(root, productDir, options.target, snap.baseCommit)
  : { requested: false, snapshotMatch: false, contamination: [], runs: [] };

const evidence = {
  schemaVersion: 1,
  collectedAt: new Date().toISOString(),
  repositoryRoot: root,
  snapshot: snap,
  rubricHash,
  rubricWeighting: "equal mock weighting, 20 points per official criterion; not an official weighting",
  productScope: productDir ? relative(root, productDir) || "." : null,
  excludedFromProductJudgment: [".agents/skills/", "hackathon/judging/"],
  git: {
    status: lines(status),
    changedFiles: changed,
    branch: git(root, ["branch", "--show-current"]).stdout || "(detached)",
  },
  artifacts: artifactSummary(files),
  keywordEvidence: keywordMatches(root, options.target, snap.baseCommit),
  verification,
};

const output = resolve(root, options.output || "hackathon/judging/evidence/latest.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${output}\n`);
