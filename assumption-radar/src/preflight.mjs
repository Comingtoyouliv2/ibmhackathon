import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function command(program, args, options = {}) {
  return new Promise((done) => {
    execFile(program, args, { timeout: options.timeout || 180_000, maxBuffer: 12 * 1024 * 1024 }, (error, stdout = "", stderr = "") => {
      done({ code: error ? Number(error.code) || 1 : 0, stdout, stderr, error });
    });
  });
}

const unique = (values) => [...new Set(values.filter(Boolean))];

export function parseMergeTreeResult(result) {
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const conflictPaths = unique([...text.matchAll(/CONFLICT\s+\([^)]*\):[^\n]*?\s+in\s+(.+)$/gm)].map((match) => match[1].trim()));
  const messages = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^CONFLICT\b/.test(line)).slice(0, 20);
  const treeOid = (result.stdout || "").split(/\r?\n/, 1)[0]?.trim();
  if (result.code === 0) return { status: "clean", conflictPaths: [], messages: [], treeOid: /^[0-9a-f]{40,64}$/i.test(treeOid) ? treeOid : null };
  if (result.code === 1 && (conflictPaths.length || messages.length)) return { status: "textual-conflict", conflictPaths, messages, treeOid: /^[0-9a-f]{40,64}$/i.test(treeOid) ? treeOid : null };
  return { status: "unavailable", conflictPaths: [], messages: [], treeOid: null, error: (result.stderr || result.error?.message || "git merge-tree failed").trim().slice(0, 500) };
}

export class GitMergeTreePreflight {
  constructor(repository, options = {}) {
    this.repository = repository;
    this.cacheRoot = resolve(options.cacheDir || process.env.ASSUMPTION_RADAR_CACHE_DIR || join(ROOT, ".cache", "repos"));
    this.repoDir = join(this.cacheRoot, `${repository.replaceAll("/", "__")}.git`);
    this.git = options.runner || command;
    this.virtualHeads = new Map();
    this.baseMergeStatuses = new Map();
  }

  ref(number) {
    return `refs/assumption-radar/pr-${number}`;
  }

  baseRef(name = "main") {
    const safe = String(name).replace(/[^A-Za-z0-9._/-]/g, "-").replace(/\.{2,}/g, "-").replace(/^[-/.]+|[-/.]+$/g, "") || "main";
    return `refs/assumption-radar/base/${safe}`;
  }

  async initialize(prs) {
    await mkdir(this.cacheRoot, { recursive: true });
    let initialized = true;
    try { await access(join(this.repoDir, "HEAD")); }
    catch { initialized = false; }
    if (!initialized) {
      const init = await this.git("git", ["init", "--bare", this.repoDir]);
      if (init.code !== 0) throw new Error(`git cache init failed: ${init.stderr || init.stdout}`);
      const remote = await this.git("git", ["-C", this.repoDir, "remote", "add", "origin", `https://github.com/${this.repository}.git`]);
      if (remote.code !== 0) throw new Error(`git remote add failed: ${remote.stderr || remote.stdout}`);
    }
    const numbers = unique(prs.map((pr) => Number(pr.number))).sort((a, b) => a - b);
    const bases = unique(prs.map((pr) => pr.base || "main")).sort();
    const refspecs = [
      ...numbers.map((number) => `+refs/pull/${number}/head:${this.ref(number)}`),
      ...bases.map((base) => `+refs/heads/${base}:${this.baseRef(base)}`),
    ];
    const fetched = await this.git("git", ["-C", this.repoDir, "fetch", "--force", "--no-tags", "--filter=blob:none", "origin", ...refspecs]);
    if (fetched.code !== 0) throw new Error(`git fetch failed: ${(fetched.stderr || fetched.stdout).trim().slice(0, 500)}`);
    return { repoDir: this.repoDir, fetchedPrs: numbers.length, fetchedBases: bases };
  }

  async prepareBaseMerges(prs) {
    this.virtualHeads.clear();
    this.baseMergeStatuses.clear();
    const results = [];
    for (const pr of prs) {
      const number = Number(pr.number);
      const base = this.baseRef(pr.base || "main");
      const merge = await this.git("git", ["-C", this.repoDir, "merge-tree", "--write-tree", "--name-only", "--messages", base, this.ref(number)]);
      const parsed = parseMergeTreeResult(merge);
      if (parsed.status !== "clean" || !parsed.treeOid) {
        const status = parsed.status === "textual-conflict" ? "base-conflict" : "unavailable";
        const record = { prNumber: number, base: pr.base || "main", status, conflictPaths: parsed.conflictPaths, messages: parsed.messages, error: parsed.error };
        this.baseMergeStatuses.set(number, record);
        results.push(record);
        continue;
      }
      const commit = await this.git("git", [
        "-C", this.repoDir,
        "-c", "user.name=Assumption Radar",
        "-c", "user.email=assumption-radar@localhost",
        "commit-tree", parsed.treeOid,
        "-p", base,
        "-p", this.ref(number),
        "-m", `assumption-radar virtual merge for PR #${number}`,
      ]);
      const commitOid = commit.stdout.trim();
      if (commit.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(commitOid)) {
        const record = { prNumber: number, base: pr.base || "main", status: "unavailable", conflictPaths: [], messages: [], error: (commit.stderr || commit.stdout || "git commit-tree failed").trim().slice(0, 500) };
        this.baseMergeStatuses.set(number, record);
        results.push(record);
        continue;
      }
      this.virtualHeads.set(number, commitOid);
      const record = { prNumber: number, base: pr.base || "main", status: "clean", treeOid: parsed.treeOid, commitOid, conflictPaths: [], messages: [] };
      this.baseMergeStatuses.set(number, record);
      results.push(record);
    }
    return results;
  }

  async isAncestor(leftNumber, rightNumber) {
    const result = await this.git("git", ["-C", this.repoDir, "merge-base", "--is-ancestor", this.ref(leftNumber), this.ref(rightNumber)]);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new Error(`git merge-base failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }

  async findStacks(prs) {
    if (prs.length < 2) return [];

    const refs = prs.map((pr) => this.ref(pr.number));
    const resolved = await this.git("git", ["-C", this.repoDir, "rev-parse", ...refs]);
    const objectIds = resolved.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (resolved.code !== 0 || objectIds.length !== prs.length) {
      throw new Error(`git rev-parse failed: ${(resolved.stderr || resolved.stdout).trim().slice(0, 300)}`);
    }

    const byObjectId = new Map();
    prs.forEach((pr, index) => {
      const oid = objectIds[index];
      if (!byObjectId.has(oid)) byObjectId.set(oid, []);
      byObjectId.get(oid).push(pr);
    });

    const stacks = [];
    const representatives = [];
    for (const group of byObjectId.values()) {
      const ordered = [...group].sort((left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0));
      const descendant = ordered[0];
      representatives.push(descendant);
      for (const ancestor of ordered.slice(1)) {
        stacks.push({ ancestorId: ancestor.id, ancestorNumber: ancestor.number, descendantId: descendant.id, descendantNumber: descendant.number, identicalHeads: true });
      }
    }

    if (representatives.length < 2) return stacks;
    const independent = await this.git("git", ["-C", this.repoDir, "merge-base", "--independent", ...representatives.map((pr) => this.ref(pr.number))]);
    if (independent.code !== 0) throw new Error(`git merge-base --independent failed: ${(independent.stderr || independent.stdout).trim().slice(0, 300)}`);
    const independentIds = new Set(independent.stdout.trim().split(/\r?\n/).filter(Boolean));
    const oidByNumber = new Map(representatives.map((pr) => [Number(pr.number), objectIds[prs.indexOf(pr)]]));
    const retained = representatives.filter((pr) => independentIds.has(oidByNumber.get(Number(pr.number))));
    const suppressed = representatives.filter((pr) => !independentIds.has(oidByNumber.get(Number(pr.number))));

    const queue = [...suppressed];
    const lineage = [];
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
      while (queue.length) {
        const ancestor = queue.shift();
        for (const descendant of retained) {
          if (!await this.isAncestor(ancestor.number, descendant.number)) continue;
          lineage.push({ ancestorId: ancestor.id, ancestorNumber: ancestor.number, descendantId: descendant.id, descendantNumber: descendant.number, identicalHeads: false });
          break;
        }
      }
    });
    await Promise.all(workers);
    return [...stacks, ...lineage];
  }

  async inspectPair(comparison, prsById) {
    const left = prsById.get(comparison.prIds[0]);
    const right = prsById.get(comparison.prIds[1]);
    if (!left || !right) return { key: comparison.key, status: "unavailable", error: "PR metadata missing" };
    if ((left.base || "main") !== (right.base || "main")) return { key: comparison.key, status: "unavailable", prNumbers: [left.number, right.number], error: "PRs target different base branches" };
    const leftBase = this.baseMergeStatuses.get(Number(left.number));
    const rightBase = this.baseMergeStatuses.get(Number(right.number));
    if (leftBase?.status === "base-conflict" || rightBase?.status === "base-conflict") {
      return {
        key: comparison.key,
        status: "base-conflict",
        prNumbers: [left.number, right.number],
        baseConflictPrNumbers: [leftBase, rightBase].filter((item) => item?.status === "base-conflict").map((item) => item.prNumber),
        conflictPaths: unique([...(leftBase?.conflictPaths || []), ...(rightBase?.conflictPaths || [])]),
        messages: unique([...(leftBase?.messages || []), ...(rightBase?.messages || [])]),
      };
    }
    const leftHead = this.virtualHeads.get(Number(left.number));
    const rightHead = this.virtualHeads.get(Number(right.number));
    if (!leftHead || !rightHead) return { key: comparison.key, status: "unavailable", prNumbers: [left.number, right.number], error: "base-normalized PR merge missing" };
    // The virtual commits each have current base and the original PR head as
    // parents. Letting Git infer a merge base can therefore produce multiple
    // merge bases and silently treat one PR's change as already integrated.
    // Pin the repository's current base so the pair comparison is exactly
    // (base + left changes) versus (base + right changes).
    const base = this.baseRef(left.base || "main");
    const result = await this.git("git", [
      "-C", this.repoDir,
      "merge-tree", "--write-tree", "--name-only", "--messages",
      `--merge-base=${base}`,
      leftHead, rightHead,
    ]);
    return { key: comparison.key, prNumbers: [left.number, right.number], ...parseMergeTreeResult(result) };
  }

  async inspectPairs(comparisons, prs) {
    const prsById = new Map(prs.map((pr) => [pr.id, pr]));
    const queue = [...comparisons];
    const results = [];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) results.push(await this.inspectPair(queue.shift(), prsById));
    });
    await Promise.all(workers);
    return results;
  }
}
