#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(scriptDir, "..");
const originalRoot = command("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() }).stdout;
const configPath = join(skillDir, "references", "automation-config.json");
const schemaPath = join(skillDir, "references", "scorecard-output.schema.json");
const collectorPath = join(scriptDir, "collect-evidence.mjs");
const validatorPath = join(scriptDir, "validate-scorecard.mjs");
const juryPromptPath = join(skillDir, "references", "jury-agent-prompt.md");
const implementerPromptPath = join(skillDir, "references", "implementer-agent-prompt.md");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const originalEnv = { ...process.env };
const codexBinary = resolveCodexBinary();
for (const variable of [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]) {
  delete originalEnv[variable];
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs || 60_000,
    maxBuffer: options.maxBuffer || 100 * 1024 * 1024,
  });
  const output = {
    executable,
    args,
    command: [executable, ...args].join(" "),
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error?.message || null,
  };
  if (!options.allowFailure && result.status !== 0) {
    const reason = output.stderr || output.stdout || output.error || `signal ${output.signal}`;
    throw new Error(`${output.command} failed: ${reason}`);
  }
  return output;
}

function git(cwd, args, options = {}) {
  return command("git", args, { cwd, ...options });
}

function lines(value) {
  return value ? value.split(/\r?\n/).filter(Boolean) : [];
}

function resolveCodexBinary() {
  if (process.env.IBM_JURY_CODEX_BIN) return process.env.IBM_JURY_CODEX_BIN;
  const candidates = [
    join(dirname(process.execPath), "codex"),
    ...(process.env.PATH || "").split(delimiter).filter(Boolean).map((directory) => join(directory, "codex")),
  ];
  const unique = [...new Set(candidates.filter((path) => existsSync(path)))];
  const versioned = unique.flatMap((path) => {
    const result = command(path, ["--version"], { cwd: originalRoot, allowFailure: true });
    const output = `${result.stdout} ${result.stderr}`;
    const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
    return match ? [{ path, version: match.slice(1, 4).map(Number), prerelease: /alpha|beta|rc/i.test(output) }] : [];
  });
  const stable = versioned.filter((item) => !item.prerelease);
  const selectable = stable.length ? stable : versioned;
  selectable.sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      if (left.version[index] !== right.version[index]) return right.version[index] - left.version[index];
    }
    return 0;
  });
  return selectable[0]?.path || "codex";
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function log(message) {
  process.stderr.write(`[IBM jury] ${message}\n`);
}

function writeAgentLog(runDir, label, result) {
  writeFileSync(
    join(runDir, `${label}.log`),
    `COMMAND\n${result.command}\n\nSTDOUT\n${result.stdout}\n\nSTDERR\n${result.stderr}\n`,
  );
}

function pathMatches(path, rule) {
  return rule.endsWith("/") ? path.startsWith(rule) : path === rule;
}

function pathAllowed(path) {
  if (config.forbiddenImplementationPaths.some((rule) => pathMatches(path, rule))) return false;
  return config.allowedImplementationPaths.some((rule) => pathMatches(path, rule));
}

function unstagedRelevantPaths(cwd, env) {
  const tracked = lines(git(cwd, ["diff", "--name-only"], { env }).stdout);
  const untracked = lines(git(cwd, ["ls-files", "--others", "--exclude-standard"], { env }).stdout);
  return [...new Set([...tracked, ...untracked])].filter(pathAllowed).sort();
}

function changedPaths(cwd, env) {
  const tracked = lines(git(cwd, ["diff", "--name-only", "HEAD"], { env }).stdout);
  const untracked = lines(git(cwd, ["ls-files", "--others", "--exclude-standard"], { env }).stdout);
  return [...new Set([...tracked, ...untracked])].sort();
}

function assertSafeChangedPaths(cwd, env, paths) {
  if (!paths.length) throw new Error("Implementation agent produced no file changes.");
  const rejected = paths.filter((path) => !pathAllowed(path));
  if (rejected.length) throw new Error(`Implementation touched forbidden paths: ${rejected.join(", ")}`);
  for (const path of paths) {
    const absolute = join(cwd, path);
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
      throw new Error(`Implementation created or modified a symlink: ${path}`);
    }
  }
  git(cwd, ["add", "-A", "--", ...paths], { env });
  const summary = git(cwd, ["diff", "--cached", "--summary", "HEAD"], { env }).stdout;
  if (/mode change|mode 120000/.test(summary)) {
    throw new Error(`Implementation changed file modes or introduced a symlink:\n${summary}`);
  }
}

function gateResult(scorecard) {
  const criterionScores = Object.values(scorecard.criteria).map((item) => item.score);
  const failures = [];
  if (scorecard.total < config.gate.total) failures.push(`total ${scorecard.total} < ${config.gate.total}`);
  if (Math.min(...criterionScores) < config.gate.minimumCriterion) {
    failures.push(`minimum criterion ${Math.min(...criterionScores)} < ${config.gate.minimumCriterion}`);
  }
  if (scorecard.fatalRisks.length > config.gate.maximumFatalRisks) {
    failures.push(`fatal risks ${scorecard.fatalRisks.length} > ${config.gate.maximumFatalRisks}`);
  }
  for (const [path, minimum] of Object.entries(config.gate.minimumSubscores || {})) {
    const [criterion, subscore] = path.split(".");
    const actual = scorecard.criteria?.[criterion]?.subscores?.[subscore];
    if (!Number.isFinite(actual) || actual < minimum) failures.push(`${path} ${actual ?? "missing"} < ${minimum}`);
  }
  return { passed: failures.length === 0, failures };
}

function scoreImproved(before, after) {
  if (after.rubricHash !== before.rubricHash) {
    return { improved: false, reason: "rubric hash changed between jury runs" };
  }
  const minimumGain = config.gate.minimumTotalGain ?? 0;
  const gain = after.total - before.total;
  if (gain < minimumGain) {
    return {
      improved: false,
      reason: `total gain ${gain} is below the acceptance margin ${minimumGain} (${before.total} → ${after.total})`,
    };
  }
  const regressions = Object.keys(before.criteria)
    .filter((key) => after.criteria[key].score < before.criteria[key].score)
    .map((key) => `${key} ${before.criteria[key].score}→${after.criteria[key].score}`);
  if (regressions.length) return { improved: false, reason: `criterion regression: ${regressions.join(", ")}` };
  if (after.fatalRisks.length > before.fatalRisks.length) {
    return { improved: false, reason: "fatal-risk count increased" };
  }
  return { improved: true, reason: `total ${before.total} → ${after.total}` };
}

function codexArgs({ cwd, model, effort, sandbox, schema, output }) {
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--disable",
    "multi_agent",
    "--sandbox",
    sandbox,
    "--model",
    model,
    "--config",
    `model_reasoning_effort="${effort}"`,
    "--color",
    "never",
    "--cd",
    cwd,
  ];
  if (schema) args.push("--output-schema", schema);
  if (output) args.push("--output-last-message", output);
  args.push("-");
  return args;
}

function runJuryAgent(cwd, env, evidencePath, outputPath, runDir, label) {
  const contract = readFileSync(juryPromptPath, "utf8");
  const prompt = `${contract}

Invocation paths:
- Evidence bundle: ${evidencePath}
- Shared brief: ${join(skillDir, "references", "hackathon-brief.md")}
- Scoring contract: ${join(skillDir, "references", "scoring-contract.md")}
- Machine rubric: ${join(skillDir, "references", "rubric.json")}
- Technical judge: ${resolve(skillDir, "../ibm-hackathon-technical-judge")}
- Innovation judge: ${resolve(skillDir, "../ibm-hackathon-innovation-judge")}
- Feasibility judge: ${resolve(skillDir, "../ibm-hackathon-feasibility-judge")}
- Challenge-fit judge: ${resolve(skillDir, "../ibm-hackathon-challenge-fit-judge")}
- Impact judge: ${resolve(skillDir, "../ibm-hackathon-impact-judge")}

The repository under review is ${cwd}. Return JSON only.`;
  log(`starting isolated jury agent (${config.jury.model}, ${config.jury.reasoningEffort})`);
  const result = command(
    codexBinary,
    codexArgs({
      cwd,
      model: config.jury.model,
      effort: config.jury.reasoningEffort,
      sandbox: "read-only",
      schema: schemaPath,
      output: outputPath,
    }),
    {
      cwd,
      env,
      input: prompt,
      timeoutMs: config.jury.timeoutSeconds * 1_000,
      allowFailure: true,
    },
  );
  writeAgentLog(runDir, `${label}-jury-agent`, result);
  if (result.status !== 0) throw new Error(`Isolated jury agent failed; see ${join(runDir, `${label}-jury-agent.log`)}`);
  if (!existsSync(outputPath)) throw new Error("Jury agent did not produce a scorecard.");
}

function assess(cwd, env, runDir, label) {
  const evidencePath = join(runDir, `${label}-evidence.json`);
  const scorecardPath = join(runDir, `${label}-scorecard.json`);
  const reportPath = join(runDir, `${label}-scorecard.md`);
  log(`collecting exact staged evidence (${label})`);
  command("node", [collectorPath, "--target", "staged", "--output", evidencePath, "--verify"], {
    cwd,
    env,
    timeoutMs: 420_000,
  });
  runJuryAgent(cwd, env, evidencePath, scorecardPath, runDir, label);
  command("node", [validatorPath, scorecardPath, "--evidence", evidencePath, "--render", reportPath], {
    cwd,
    env,
  });
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const failedRuns = evidence.verification.runs.filter((run) => !run.passed);
  if (!evidence.verification.snapshotMatch || failedRuns.length) {
    throw new Error(
      `Verification does not match or pass the staged snapshot: contamination=${evidence.verification.contamination.join(", ") || "none"}, failures=${failedRuns.map((run) => run.command).join(", ") || "none"}`,
    );
  }
  const scorecard = JSON.parse(readFileSync(scorecardPath, "utf8"));
  const gate = gateResult(scorecard);
  log(`${label}: ${scorecard.total}/100; gate ${gate.passed ? "PASS" : `FAIL (${gate.failures.join("; ")})`}`);
  return { evidence, scorecard, scorecardPath, reportPath, gate };
}

function temporaryCommit(tree, env) {
  const head = git(originalRoot, ["rev-parse", "HEAD"], { env }).stdout;
  const identityEnv = {
    ...env,
    GIT_AUTHOR_NAME: "IBM Jury Loop",
    GIT_AUTHOR_EMAIL: "jury-loop@localhost",
    GIT_COMMITTER_NAME: "IBM Jury Loop",
    GIT_COMMITTER_EMAIL: "jury-loop@localhost",
  };
  return git(originalRoot, ["commit-tree", tree, "-p", head], {
    env: identityEnv,
    input: "temporary jury candidate\n",
  }).stdout;
}

function withTemporaryWorktree(tree, candidateEnv, callback) {
  const tempRoot = mkdtempSync(join(tmpdir(), "ibm-jury-worktree-"));
  const commit = temporaryCommit(tree, candidateEnv);
  git(originalRoot, ["worktree", "add", "--detach", tempRoot, commit], { env: originalEnv });
  try {
    return callback(tempRoot);
  } finally {
    git(originalRoot, ["worktree", "remove", "--force", tempRoot], { env: originalEnv, allowFailure: true });
    if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runImplementationAgent(tempRoot, tempEnv, scorecard, runDir, iteration, previousFailures) {
  const contract = readFileSync(implementerPromptPath, "utf8");
  const prompt = `${contract}

Allowed paths:
${config.allowedImplementationPaths.map((path) => `- ${path}`).join("\n")}

Forbidden paths:
${config.forbiddenImplementationPaths.map((path) => `- ${path}`).join("\n")}

Independent jury scorecard:
${JSON.stringify(scorecard, null, 2)}

Supervisor notes from earlier isolated attempts in this loop:
${previousFailures.length ? previousFailures.map((failure) => `- ${failure}`).join("\n") : "- None"}
`;
  log(`starting isolated implementation agent ${iteration} (${config.implementer.model}, ${config.implementer.reasoningEffort})`);
  const outputPath = join(runDir, `iteration-${iteration}-implementer-final.txt`);
  const result = command(
    codexBinary,
    codexArgs({
      cwd: tempRoot,
      model: config.implementer.model,
      effort: config.implementer.reasoningEffort,
      sandbox: "workspace-write",
      output: outputPath,
    }),
    {
      cwd: tempRoot,
      env: tempEnv,
      input: prompt,
      timeoutMs: config.implementer.timeoutSeconds * 1_000,
      allowFailure: true,
    },
  );
  writeAgentLog(runDir, `iteration-${iteration}-implementer-agent`, result);
  if (result.status !== 0) {
    throw new Error(`Implementation agent failed; see ${join(runDir, `iteration-${iteration}-implementer-agent.log`)}`);
  }
}

function linkDependencies(tempRoot) {
  const source = join(originalRoot, config.productDirectory, "node_modules");
  const target = join(tempRoot, config.productDirectory, "node_modules");
  if (!existsSync(source) || existsSync(target)) return null;
  symlinkSync(source, target, "dir");
  return target;
}

function implementAndAssess(candidateTree, candidateEnv, before, runDir, iteration, previousFailures) {
  return withTemporaryWorktree(candidateTree, candidateEnv, (tempRoot) => {
    const tempEnv = { ...originalEnv };
    delete tempEnv.GIT_INDEX_FILE;
    runImplementationAgent(tempRoot, tempEnv, before.scorecard, runDir, iteration, previousFailures);
    const paths = changedPaths(tempRoot, tempEnv);
    assertSafeChangedPaths(tempRoot, tempEnv, paths);
    const dependencyLink = linkDependencies(tempRoot);
    try {
      const after = assess(tempRoot, tempEnv, runDir, `iteration-${iteration}`);
      const improvement = scoreImproved(before.scorecard, after.scorecard);
      if (!improvement.improved) throw new Error(`Fresh jury rejected candidate: ${improvement.reason}`);
      const patch = git(tempRoot, ["diff", "--cached", "--binary", "--full-index", "HEAD"], {
        env: tempEnv,
        maxBuffer: 100 * 1024 * 1024,
      }).stdout;
      if (!patch) throw new Error("Accepted candidate produced an empty patch.");
      return { after, patch, paths, improvement };
    } finally {
      if (dependencyLink && existsSync(dependencyLink)) unlinkSync(dependencyLink);
    }
  });
}

function applyCandidatePatch(patch, candidateEnv, runDir, iteration) {
  const patchPath = join(runDir, `iteration-${iteration}.patch`);
  writeFileSync(patchPath, `${patch}\n`);
  git(originalRoot, ["apply", "--index", "--binary", "--whitespace=nowarn", patchPath], {
    env: candidateEnv,
    timeoutMs: 120_000,
  });
}

function publishCandidateIndex(candidateEnv) {
  const tree = git(originalRoot, ["write-tree"], { env: candidateEnv }).stdout;
  git(originalRoot, ["read-tree", tree], { env: originalEnv });
  const published = git(originalRoot, ["write-tree"], { env: originalEnv }).stdout;
  if (published !== tree) throw new Error(`Index publication mismatch: ${published} != ${tree}`);
  return tree;
}

function effectiveIndexPath() {
  const raw = git(originalRoot, ["rev-parse", "--git-path", "index"], { env: originalEnv }).stdout;
  return isAbsolute(raw) ? raw : resolve(originalRoot, raw);
}

function checkSetup() {
  const required = [
    configPath,
    schemaPath,
    collectorPath,
    validatorPath,
    juryPromptPath,
    implementerPromptPath,
    join(originalRoot, ".githooks", "pre-commit"),
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length) throw new Error(`Missing automation files: ${missing.join(", ")}`);
  const codex = command(codexBinary, ["--version"], { cwd: originalRoot });
  const hookPath = git(originalRoot, ["config", "--local", "--get", "core.hooksPath"], {
    env: originalEnv,
    allowFailure: true,
  }).stdout;
  process.stdout.write(`Codex: ${codex.stdout} (${codexBinary})\nHook path: ${hookPath || "(not installed)"}\nConfig: ${configPath}\nSetup check passed.\n`);
}

const args = new Set(process.argv.slice(2));
if (args.has("--check")) {
  checkSetup();
  process.exit(0);
}
if (process.env.IBM_JURY_SKIP === "1") {
  log("skipped by IBM_JURY_SKIP=1");
  process.exit(0);
}
if (config.schemaVersion !== 1) throw new Error("Unsupported automation config schema.");

const staged = lines(git(originalRoot, ["diff", "--cached", "--name-only"], { env: originalEnv }).stdout);
if (!staged.length) {
  log("index is empty; nothing to judge");
  process.exit(0);
}

const gitDir = git(originalRoot, ["rev-parse", "--absolute-git-dir"], { env: originalEnv }).stdout;
const runDir = join(gitDir, "jury-loop", `${timestamp()}-${process.pid}`);
mkdirSync(runDir, { recursive: true });
const indexPath = effectiveIndexPath();
const candidateIndex = join(runDir, "candidate.index");
copyFileSync(indexPath, candidateIndex);
chmodSync(candidateIndex, 0o600);
const candidateEnv = { ...originalEnv, GIT_INDEX_FILE: candidateIndex };

log(`run artifacts: ${runDir}`);

try {
  let current = assess(originalRoot, candidateEnv, runDir, "initial");
  if (args.has("--jury-only")) {
    process.stdout.write(`${current.reportPath}\n`);
    process.exit(current.gate.passed ? 0 : 1);
  }
  if (current.gate.passed) {
    log("gate passed; commit may continue");
    process.exit(0);
  }

  const dirty = unstagedRelevantPaths(originalRoot, candidateEnv);
  if (dirty.length) {
    throw new Error(`Automatic implementation requires staged content to match the worktree for allowed paths. Stage or stash: ${dirty.join(", ")}`);
  }
  if (process.env.IBM_JURY_AUTOFIX === "0" || args.has("--no-implement")) {
    throw new Error(`Jury gate failed and autofix is disabled. Report: ${current.reportPath}`);
  }

  const configuredIterations = Number(process.env.IBM_JURY_MAX_ITERATIONS || config.maxIterations);
  const maxIterations = Math.max(1, Math.min(10, configuredIterations || config.maxIterations));
  let acceptedChanges = false;
  const rejectedAttempts = [];

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const candidateTree = git(originalRoot, ["write-tree"], { env: candidateEnv }).stdout;
    let result;
    try {
      result = implementAndAssess(candidateTree, candidateEnv, current, runDir, iteration, rejectedAttempts);
    } catch (error) {
      const reason = `attempt ${iteration}: ${error.message}`;
      rejectedAttempts.push(reason);
      log(`rejected implementation ${iteration}; ${error.message}`);
      continue;
    }
    log(`accepted implementation ${iteration}: ${result.improvement.reason}; paths=${result.paths.join(", ")}`);
    applyCandidatePatch(result.patch, candidateEnv, runDir, iteration);
    current = result.after;
    acceptedChanges = true;
    if (current.gate.passed) {
      const tree = publishCandidateIndex(candidateEnv);
      log(`gate passed after ${iteration} implementation(s); staged tree=${tree}`);
      process.exit(0);
    }
  }

  if (acceptedChanges) {
    const tree = publishCandidateIndex(candidateEnv);
    throw new Error(
      `Maximum iterations reached. Best improving changes were staged as ${tree}, but the commit is blocked for another review cycle. Latest report: ${current.reportPath}`,
    );
  }
  throw new Error(
    `No accepted improvement after ${maxIterations} attempt(s). Latest report: ${current.reportPath}. Rejections: ${rejectedAttempts.join(" | ")}`,
  );
} catch (error) {
  log(`BLOCKED: ${error.message}`);
  log(`inspect ${runDir}`);
  process.exit(1);
}
