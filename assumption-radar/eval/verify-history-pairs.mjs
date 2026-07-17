#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseMergeTreeResult } from "../src/preflight.mjs";

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) {
  console.error("Usage: npm run verify:history -- <source.jsonl> <output-dir>");
  process.exit(1);
}

function command(program, args, options = {}) {
  return new Promise((done) => {
    execFile(program, args, {
      timeout: options.timeout || 600_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout = "", stderr = "") => {
      done({ code: error ? Number(error.code) || 1 : 0, stdout, stderr, error });
    });
  });
}

const unique = (values) => [...new Set(values.filter(Boolean))];
const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}${records.length ? "\n" : ""}`;

async function exists(path) {
  try { await access(path); return true; }
  catch { return false; }
}

async function ensureRepository(cacheRoot, project) {
  const repoDir = join(cacheRoot, `${project.replaceAll("/", "__")}.git`);
  if (!await exists(join(repoDir, "HEAD"))) {
    const initialized = await command("git", ["init", "--bare", repoDir]);
    if (initialized.code !== 0) throw new Error(`${project}: git init failed: ${initialized.stderr}`);
    const remote = await command("git", ["-C", repoDir, "remote", "add", "origin", `https://github.com/${project}.git`]);
    if (remote.code !== 0) throw new Error(`${project}: remote add failed: ${remote.stderr}`);
  }
  return repoDir;
}

async function inspectProject(cacheRoot, project, records) {
  const repoDir = await ensureRepository(cacheRoot, project);
  const mergeCommits = unique(records.map((record) => record.mergeCommit));
  const fetched = await command("git", ["-C", repoDir, "fetch", "--force", "--no-tags", "--filter=blob:none", "origin", ...mergeCommits]);
  if (fetched.code !== 0) {
    return records.map((record) => ({
      id: record.id, project, sourceLabel: record.label, sourceRefs: sourceRefs(record),
      verification: "unavailable", semanticEligibility: "excluded", error: (fetched.stderr || fetched.stdout).trim().slice(0, 800),
    }));
  }

  const results = [];
  for (const record of records) results.push(await inspectRecord(repoDir, record));
  return results;
}

function sourceRefs(record) {
  return {
    mergeCommit: record.mergeCommit,
    base: record.base,
    parentA: record.parentA,
    parentB: record.parentB,
  };
}

async function inspectRecord(repoDir, record) {
  const show = await command("git", ["-C", repoDir, "show", "-s", "--format=%H%n%P%n%T", record.mergeCommit]);
  if (show.code !== 0) {
    return {
      id: record.id, project: record.project, sourceLabel: record.label, sourceRefs: sourceRefs(record),
      verification: "unavailable", semanticEligibility: "excluded", error: (show.stderr || show.stdout).trim().slice(0, 800),
    };
  }
  const [observedMerge, parentsLine = "", mergeTreeOid = ""] = show.stdout.trim().split(/\r?\n/);
  const observedParents = parentsLine.trim().split(/\s+/).filter(Boolean);
  const expectedParents = [record.parentA, record.parentB];
  const parentMatch = expectedParents.every((parent) => observedParents.includes(parent)) && observedParents.length === 2;

  const mergeBase = await command("git", ["-C", repoDir, "merge-base", record.parentA, record.parentB]);
  const observedBase = mergeBase.stdout.trim();
  const baseMatch = mergeBase.code === 0 && observedBase === record.base;
  const merge = await command("git", ["-C", repoDir, "merge-tree", "--write-tree", "--name-only", "--messages", record.parentA, record.parentB]);
  const parsed = parseMergeTreeResult(merge);
  const autoTreeOid = parsed.treeOid;
  const autoTreeMatchesRecordedMerge = parsed.status === "clean" && Boolean(autoTreeOid) && autoTreeOid === mergeTreeOid;
  const verified = observedMerge === record.mergeCommit && parentMatch && baseMatch;
  const clean = parsed.status === "clean";

  return {
    schemaVersion: "history-candidate-v0.1",
    id: record.id,
    project: record.project,
    sourceLabel: record.label,
    sourceRefs: sourceRefs(record),
    hints: record.hints || [],
    diffStats: { linesA: record.linesA, linesB: record.linesB },
    verification: verified ? "verified-refs" : "ref-mismatch",
    observed: {
      parents: observedParents,
      mergeBase: observedBase || null,
      mechanicalMerge: parsed.status,
      conflictPaths: parsed.conflictPaths,
      conflictMessages: parsed.messages,
      autoTreeOid,
      recordedMergeTreeOid: mergeTreeOid || null,
      autoTreeMatchesRecordedMerge,
    },
    semanticEligibility: verified && clean ? "candidate" : "excluded",
    semanticLabel: null,
    adjudicationStatus: "unlabeled",
    notes: "Source label is candidate metadata only and must not be used as gold.",
    ...(parsed.error ? { error: parsed.error } : {}),
  };
}

function report(records, sourcePath) {
  const count = (predicate) => records.filter(predicate).length;
  const projects = new Set(records.map((record) => record.project));
  const eligible = records.filter((record) => record.semanticEligibility === "candidate");
  const sourceConflicts = eligible.filter((record) => record.sourceLabel === "conflict");
  const sourceHarmless = eligible.filter((record) => record.sourceLabel === "harmless");
  const conflictPaths = records.filter((record) => record.observed?.mechanicalMerge === "textual-conflict");
  return [
    "# Historical merge-pair mechanical verification",
    "",
    "> Source labels are not gold. This report only establishes repository identity and mechanical clean-merge eligibility.",
    "",
    `- Source: \`${sourcePath}\``,
    `- Records: ${records.length}`,
    `- Repositories: ${projects.size}`,
    `- Verified refs: ${count((record) => record.verification === "verified-refs")}`,
    `- Clean-merge semantic candidates: ${eligible.length}`,
    `- Candidate source labels: ${sourceConflicts.length} conflict / ${sourceHarmless.length} harmless`,
    `- Mechanical conflicts excluded: ${conflictPaths.length}`,
    `- Unavailable or mismatched: ${count((record) => !["verified-refs"].includes(record.verification))}`,
    `- Recorded merge tree equals automatic clean merge: ${count((record) => record.observed?.autoTreeMatchesRecordedMerge)}`,
    "",
    "## Next gate",
    "",
    "Every eligible pair requires independent semantic adjudication using both diffs, repository context, and preferably executable tests. A source `conflict` label never becomes a positive without that gate.",
    "",
  ].join("\n");
}

async function main() {
  const sourcePath = resolve(sourceArg);
  const outputDir = resolve(outputArg);
  const source = (await readFile(sourcePath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const byProject = new Map();
  for (const record of source) {
    const group = byProject.get(record.project) || [];
    group.push(record);
    byProject.set(record.project, group);
  }
  const cacheRoot = resolve(".cache", "history");
  await Promise.all([mkdir(cacheRoot, { recursive: true }), mkdir(outputDir, { recursive: true })]);

  const queue = [...byProject.entries()];
  const results = [];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const [project, records] = queue.shift();
      results.push(...await inspectProject(cacheRoot, project, records));
    }
  });
  await Promise.all(workers);
  results.sort((left, right) => left.project.localeCompare(right.project) || left.id.localeCompare(right.id));

  await Promise.all([
    writeFile(join(outputDir, "mechanical-verification.jsonl"), jsonl(results)),
    writeFile(join(outputDir, "report.md"), report(results, sourcePath)),
    writeFile(join(outputDir, "run.json"), `${JSON.stringify({
      schemaVersion: "history-verification-run-v0.1",
      generatedAt: new Date().toISOString(),
      sourcePath,
      outputDir,
      recordCount: results.length,
      repositoryCount: byProject.size,
    }, null, 2)}\n`),
  ]);
  console.log(`History verification complete: ${outputDir}`);
  console.log(`${results.length} pairs · ${byProject.size} repositories · ${results.filter((record) => record.semanticEligibility === "candidate").length} clean candidates`);
}

main().catch((error) => {
  console.error(`History verification: ${error.message}`);
  process.exitCode = 1;
});
