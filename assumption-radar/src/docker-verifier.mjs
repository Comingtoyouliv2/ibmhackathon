import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCombinedRuns, failureSignatures } from "./combined-verifier.mjs";
import { GitMergeTreePreflight } from "./preflight.mjs";

const DEFAULT_LIMITS = Object.freeze({ timeoutSeconds: 900, memory: "6g", cpus: "2", pids: 512 });

export const AUTO_VERIFICATION_PROFILES = Object.freeze([
  {
    profile: "node-pnpm",
    markers: ["pnpm-lock.yaml"],
    image: "node:22-bookworm",
    installCommand: "corepack enable && corepack pnpm config set store-dir /cache/pnpm && corepack pnpm install --frozen-lockfile --ignore-scripts",
    testCommand: "corepack pnpm test",
  },
  {
    profile: "node-npm",
    markers: ["package-lock.json"],
    image: "node:22-bookworm",
    installCommand: "npm ci --ignore-scripts --cache /cache/npm",
    testCommand: "npm test",
  },
  {
    profile: "node-yarn",
    markers: ["yarn.lock"],
    image: "node:22-bookworm",
    installCommand: "corepack enable && yarn install --immutable --mode=skip-builds",
    testCommand: "corepack yarn test",
  },
  {
    profile: "python-pytest",
    markers: ["pyproject.toml", "setup.py", "requirements.txt"],
    image: "python:3.12-bookworm",
    installCommand: "python -m venv .radar-venv && .radar-venv/bin/python -m pip install --cache-dir /cache/pip -U pip && if [ -f requirements.txt ]; then .radar-venv/bin/python -m pip install --cache-dir /cache/pip -r requirements.txt; fi && if [ -f pyproject.toml ] || [ -f setup.py ]; then .radar-venv/bin/python -m pip install --cache-dir /cache/pip -e .; fi && .radar-venv/bin/python -m pip install --cache-dir /cache/pip pytest",
    testCommand: ".radar-venv/bin/python -m pytest -q",
  },
]);

function execute(program, args, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(program, args, {
      encoding: "utf8",
      timeout: options.timeout || 180_000,
      maxBuffer: options.maxBuffer || 24 * 1024 * 1024,
      env: options.env || process.env,
    }, (error, stdout = "", stderr = "") => resolve({
      code: error ? (typeof error.code === "number" ? error.code : null) : 0,
      signal: error?.signal || null,
      timedOut: Boolean(error?.killed) || error?.code === "ETIMEDOUT",
      stdout: String(stdout),
      stderr: String(stderr),
      error,
      durationMs: Date.now() - started,
    }));
  });
}

async function exists(path) {
  try { await access(path); return true; }
  catch { return false; }
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  if (!profile.profile || !profile.image || !profile.installCommand || !profile.testCommand) return null;
  return { ...DEFAULT_LIMITS, ...profile };
}

export async function loadVerificationProfiles(path) {
  if (!path) return { version: 1, repositories: {} };
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || typeof parsed.repositories !== "object") {
    throw new Error("The verification profile must contain a repositories object.");
  }
  return parsed;
}

export async function resolveVerificationProfile(workspace, repository, profiles = { repositories: {} }) {
  const configured = normalizeProfile(profiles.repositories?.[repository]);
  if (configured) return { ...configured, source: "repository-config" };
  for (const candidate of AUTO_VERIFICATION_PROFILES) {
    if (await Promise.all(candidate.markers.map((marker) => exists(join(workspace, marker)))).then((values) => values.some(Boolean))) {
      return { ...DEFAULT_LIMITS, ...candidate, source: "auto-detected" };
    }
  }
  return null;
}

function safeName(value) {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 110);
}

function tail(value, max = 16_000) {
  return String(value || "").slice(-max);
}

export class DockerCombinedVerifier {
  constructor(repository, options = {}) {
    this.repository = repository;
    this.engine = options.preflightEngine || new GitMergeTreePreflight(repository, { cacheDir: options.cacheDir });
    this.run = options.runner || execute;
    this.profiles = options.profiles || { version: 1, repositories: {} };
    this.executionCache = new Map();
  }

  async git(args, options = {}) {
    const result = await this.run("git", args, { timeout: options.timeout || 240_000 });
    if (!(options.allowed || [0]).includes(result.code)) {
      throw new Error(`git ${args[2] || args[0]} failed: ${tail(result.stderr || result.stdout, 2_000)}`);
    }
    return result;
  }

  async docker(args, options = {}) {
    return this.run("docker", args, { timeout: options.timeout || 180_000 });
  }

  async assertDocker() {
    const result = await this.docker(["info", "--format", "{{.ServerVersion}}"], { timeout: 20_000 });
    if (result.code !== 0 || !result.stdout.trim()) {
      throw new Error(`Docker must be running: ${tail(result.stderr || result.stdout || result.error?.message, 500)}`);
    }
  }

  async ensureImage(image) {
    const existsResult = await this.docker(["image", "inspect", image], { timeout: 30_000 });
    if (existsResult.code === 0) return;
    const pull = await this.docker(["pull", image], { timeout: 600_000 });
    if (pull.code !== 0) throw new Error(`Docker image pull failed (${image}): ${tail(pull.stderr || pull.stdout, 1_000)}`);
  }

  async container(name, profile, workspace, cacheVolume, command, network) {
    const args = [
      "run", "--name", name, "--rm",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(profile.pids),
      "--memory", profile.memory,
      "--cpus", String(profile.cpus),
      "--env", "CI=1",
      "--env", "NO_COLOR=1",
      "--env", "HOME=/tmp/home",
      "--volume", `${workspace}:/workspace`,
      "--volume", `${cacheVolume}:/cache`,
      "--workdir", "/workspace",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=1073741824",
    ];
    if (!network) args.push("--network", "none");
    args.push(profile.image, "bash", "-lc", command);
    const result = await this.docker(args, { timeout: profile.timeoutSeconds * 1_000 });
    if (result.timedOut || result.code === null) await this.docker(["rm", "-f", name], { timeout: 20_000 });
    return result;
  }

  async executeState(label, pairId, profile, workspace, cacheVolume) {
    const installName = safeName(`assumption-radar-${pairId}-${label}-install`);
    const install = await this.container(installName, profile, workspace, cacheVolume, profile.installCommand, true);
    if (install.code !== 0) {
      const output = tail(`${install.stdout}\n${install.stderr}`);
      return {
        label,
        status: install.timedOut ? "timeout" : "runner_error",
        phase: "install",
        command: profile.installCommand,
        exitCode: install.code,
        durationMs: install.durationMs,
        failureSignatures: failureSignatures(output),
        output,
      };
    }
    const testName = safeName(`assumption-radar-${pairId}-${label}-test`);
    const tested = await this.container(testName, profile, workspace, cacheVolume, profile.testCommand, false);
    const output = tail(`${tested.stdout}\n${tested.stderr}`);
    return {
      label,
      status: tested.timedOut ? "timeout" : tested.code === 0 ? "passed" : tested.code === null ? "runner_error" : "failed",
      phase: "test",
      command: profile.testCommand,
      exitCode: tested.code,
      durationMs: install.durationMs + tested.durationMs,
      failureSignatures: tested.code === 0 ? [] : failureSignatures(output),
      output,
    };
  }

  async executeStateCached(label, commitOid, pairId, profile, workspace, cacheVolume) {
    const key = JSON.stringify({ repository: this.repository, commitOid, image: profile.image, installCommand: profile.installCommand, testCommand: profile.testCommand });
    const cached = this.executionCache.has(key);
    if (!cached) this.executionCache.set(key, this.executeState(label, pairId, profile, workspace, cacheVolume));
    const result = await this.executionCache.get(key);
    return { ...result, label, cached };
  }

  async confirmCombined(pairId, profile, workspace, cacheVolume) {
    const name = safeName(`assumption-radar-${pairId}-combined-confirmation`);
    const tested = await this.container(name, profile, workspace, cacheVolume, profile.testCommand, false);
    const output = tail(`${tested.stdout}\n${tested.stderr}`);
    return {
      label: "combined_confirmation",
      status: tested.timedOut ? "timeout" : tested.code === 0 ? "passed" : tested.code === null ? "runner_error" : "failed",
      phase: "test",
      command: profile.testCommand,
      exitCode: tested.code,
      durationMs: tested.durationMs,
      failureSignatures: tested.code === 0 ? [] : failureSignatures(output),
      output,
    };
  }

  async addWorktree(path, ref) {
    await this.git(["-C", this.engine.repoDir, "worktree", "add", "--force", "--detach", path, ref]);
  }

  async removeWorktree(path) {
    await this.git(["-C", this.engine.repoDir, "worktree", "remove", "--force", path], { allowed: [0, 128] });
  }

  async verifyPair(comparison, prsById, inspectionOverride = null) {
    const left = prsById.get(comparison.prIds[0]);
    const right = prsById.get(comparison.prIds[1]);
    const inspection = inspectionOverride || await this.engine.inspectPair(comparison, prsById);
    if (inspection.status !== "clean" || !inspection.treeOid) {
      throw new Error(`Executable verification requires a clean merge tree: ${inspection.status}`);
    }
    const leftHead = this.engine.virtualHeads.get(Number(left.number));
    const rightHead = this.engine.virtualHeads.get(Number(right.number));
    const baseRef = this.engine.baseRef(left.base || "main");
    const combined = await this.git([
      "-C", this.engine.repoDir,
      "-c", "user.name=Assumption Radar",
      "-c", "user.email=assumption-radar@localhost",
      "commit-tree", inspection.treeOid,
      "-p", leftHead,
      "-p", rightHead,
      "-m", `combined verification PR #${left.number} + #${right.number}`,
    ]);
    const combinedOid = combined.stdout.trim();
    const root = await mkdtemp(join(tmpdir(), "assumption-radar-verify-"));
    const paths = {
      base: join(root, "base"),
      a: join(root, "a"),
      b: join(root, "b"),
      combined: join(root, "combined"),
    };
    const cacheVolume = safeName(`assumption-radar-cache-${process.pid}-${left.number}-${right.number}-${Date.now()}`);
    const created = [];
    try {
      for (const [label, ref] of [["base", baseRef], ["a", leftHead], ["b", rightHead], ["combined", combinedOid]]) {
        await this.addWorktree(paths[label], ref);
        created.push(paths[label]);
      }
      const profile = await resolveVerificationProfile(paths.base, this.repository, this.profiles);
      if (!profile) throw new Error("No supported automatic execution profile was found. Specify a repository verification profile.");
      await this.ensureImage(profile.image);
      const volume = await this.docker(["volume", "create", cacheVolume]);
      if (volume.code !== 0) throw new Error(`Failed to create Docker cache volume: ${tail(volume.stderr || volume.stdout, 500)}`);
      const pairId = `${left.number}-${right.number}`;
      const baseSha = (await this.git(["-C", this.engine.repoDir, "rev-parse", baseRef])).stdout.trim();
      const base = await this.executeStateCached("base", baseSha, pairId, profile, paths.base, cacheVolume);
      const a = base.status === "passed" ? await this.executeStateCached("a", leftHead, pairId, profile, paths.a, cacheVolume) : null;
      const b = base.status === "passed" ? await this.executeStateCached("b", rightHead, pairId, profile, paths.b, cacheVolume) : null;
      const combinedRun = base.status === "passed" && a.status === "passed" && b.status === "passed"
        ? await this.executeState("combined", pairId, profile, paths.combined, cacheVolume) : null;
      const confirmation = combinedRun?.status === "failed"
        ? await this.confirmCombined(pairId, profile, paths.combined, cacheVolume) : null;
      const classification = classifyCombinedRuns({ base, a, b, combined: combinedRun, confirmation });
      return {
        key: comparison.key,
        prIds: comparison.prIds,
        prNumbers: [left.number, right.number],
        baseSha,
        headShaA: left.headSha || (await this.git(["-C", this.engine.repoDir, "rev-parse", this.engine.ref(left.number)])).stdout.trim(),
        headShaB: right.headSha || (await this.git(["-C", this.engine.repoDir, "rev-parse", this.engine.ref(right.number)])).stdout.trim(),
        combinedTreeSha: inspection.treeOid,
        profile: profile.profile,
        profileSource: profile.source,
        classification,
        runs: [base, a, b, combinedRun, confirmation].filter(Boolean),
        impact: { summary: classification.rationale },
        verifiedAt: new Date().toISOString(),
      };
    } finally {
      await this.docker(["volume", "rm", "-f", cacheVolume], { timeout: 30_000 });
      for (const path of created.reverse()) await this.removeWorktree(path).catch(() => {});
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

  async verify(prepared, candidates) {
    await this.assertDocker();
    await this.engine.initialize(prepared.prs);
    await this.engine.prepareBaseMerges(prepared.prs);
    const prsById = new Map(prepared.prs.map((pr) => [pr.id, pr]));
    const verifications = [];
    const errors = [];
    for (const comparison of candidates) {
      try { verifications.push(await this.verifyPair(comparison, prsById)); }
      catch (error) { errors.push({ key: comparison.key, prIds: comparison.prIds, error: error.message }); }
    }
    return { verifications, errors };
  }
}
