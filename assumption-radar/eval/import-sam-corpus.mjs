#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseMergeTreeResult } from "../src/preflight.mjs";

const [papersRepoArg = ".cache/sam-papers", outputArg = "benchmarks/semantic-clean-v0.1/sam-v0.1"] = process.argv.slice(2);
const CSV_PATH = "2022PHDThesis/results/sample-semantic-conflicts.csv";

function command(program, args, options = {}) {
  return new Promise((done) => {
    execFile(program, args, {
      timeout: options.timeout || 600_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout = "", stderr = "") => done({ code: error ? Number(error.code) || 1 : 0, stdout, stderr, error }));
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((item) => item.some((value) => value !== ""));
  return data.map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] || ""])));
}

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}${records.length ? "\n" : ""}`;
const cleanProject = (url) => url.replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
const stableChangeId = (project, commit, className, declaration) => {
  const suffix = createHash("sha1").update(`${className}#${declaration}`).digest("hex").slice(0, 10);
  return `${project}@${commit.slice(0, 12)}#${suffix}`;
};

async function exists(path) {
  try { await access(path); return true; }
  catch { return false; }
}

async function ensureRepository(cacheRoot, project) {
  const repoDir = join(cacheRoot, `${project.replaceAll("/", "__")}.git`);
  if (!await exists(join(repoDir, "HEAD"))) {
    const init = await command("git", ["init", "--bare", repoDir]);
    if (init.code !== 0) throw new Error(`${project}: git init failed`);
    const remote = await command("git", ["-C", repoDir, "remote", "add", "origin", `https://github.com/${project}.git`]);
    if (remote.code !== 0) throw new Error(`${project}: remote add failed`);
  }
  return repoDir;
}

async function inspectScenario(repoDir, project, commit, rows) {
  const show = await command("git", ["-C", repoDir, "show", "-s", "--format=%H%n%P%n%T%n%s", commit]);
  if (show.code !== 0) return unavailableScenario(project, commit, rows, show.stderr || show.stdout);
  const [observedCommit, parentsLine = "", recordedTreeOid = "", subject = ""] = show.stdout.trim().split(/\r?\n/);
  const parents = parentsLine.split(/\s+/).filter(Boolean);
  if (parents.length !== 2) return unavailableScenario(project, commit, rows, `expected two parents, got ${parents.length}`);
  const baseResult = await command("git", ["-C", repoDir, "merge-base", parents[0], parents[1]]);
  const merge = await command("git", ["-C", repoDir, "merge-tree", "--write-tree", "--name-only", "--messages", parents[0], parents[1]]);
  const parsed = parseMergeTreeResult(merge);
  return scenarioRecord(project, commit, rows, {
    verification: observedCommit === commit && baseResult.code === 0 ? "verified-refs" : "ref-mismatch",
    subject,
    parents,
    base: baseResult.stdout.trim() || null,
    mechanicalMerge: parsed.status,
    conflictPaths: parsed.conflictPaths,
    conflictMessages: parsed.messages,
    automaticTreeOid: parsed.treeOid,
    recordedTreeOid,
    automaticTreeMatchesRecordedMerge: parsed.status === "clean" && parsed.treeOid === recordedTreeOid,
    error: parsed.error || null,
  });
}

function unavailableScenario(project, commit, rows, error) {
  return scenarioRecord(project, commit, rows, {
    verification: "unavailable", subject: null, parents: [], base: null, mechanicalMerge: "unavailable",
    conflictPaths: [], conflictMessages: [], automaticTreeOid: null, recordedTreeOid: null,
    automaticTreeMatchesRecordedMerge: false, error: String(error || "unavailable").trim().slice(0, 800),
  });
}

function scenarioRecord(project, commit, rows, git) {
  const positiveRows = rows.filter((row) => row["Locally Observable Interference"] === "Yes").length;
  const negativeRows = rows.filter((row) => row["Locally Observable Interference"] === "No").length;
  return {
    schemaVersion: "sam-scenario-candidate-v0.1",
    scenarioId: `${project}@${commit}`,
    project,
    mergeCommit: commit,
    source: {
      corpus: "SAM Detecting Semantic Conflicts with Unit Tests",
      definition: "manually-adjudicated-locally-observable-interference",
      csvPath: CSV_PATH,
      positiveChangeCount: positiveRows,
      negativeChangeCount: negativeRows,
    },
    git,
    semanticEligibility: git.verification === "verified-refs" && git.mechanicalMerge === "clean" ? "candidate" : "excluded",
    productGoldStatus: "pending-independent-adjudication",
  };
}

function changeRecord(row, scenario) {
  const project = cleanProject(row.Project);
  const sourcePositive = row["Locally Observable Interference"] === "Yes";
  const testCase = row["Associated Test case"]?.trim();
  return {
    schemaVersion: "sam-change-candidate-v0.1",
    caseId: stableChangeId(project, row.Commit, row.Class, row["Method or Field Declaration"]),
    scenarioId: `${project}@${row.Commit}`,
    project,
    mergeCommit: row.Commit,
    className: row.Class,
    declaration: row["Method or Field Declaration"],
    sourceLabel: sourcePositive ? "local-interference" : "no-local-interference",
    sourceRationale: row["Locally Observable Interference Description"],
    leftChange: row["Left changes summay"],
    rightChange: row["Right changes summary"],
    sourceTestCase: testCase && testCase !== "-" ? testCase : null,
    mechanicalMerge: scenario.git.mechanicalMerge,
    semanticEligibility: scenario.semanticEligibility,
    productGold: {
      status: "unlabeled",
      relationship: null,
      evidenceGrade: null,
      rationale: null,
      evidenceRefs: [],
      excludesIntendedUnion: null,
    },
  };
}

function report(scenarios, changes) {
  const count = (items, predicate) => items.filter(predicate).length;
  const clean = scenarios.filter((scenario) => scenario.semanticEligibility === "candidate");
  const positiveChanges = changes.filter((change) => change.sourceLabel === "local-interference");
  const eligiblePositiveChanges = positiveChanges.filter((change) => change.semanticEligibility === "candidate");
  return [
    "# SAM corpus import",
    "",
    "> SAM's source label is manually adjudicated locally observable interference. It is retained as evidence, not copied into Assumption Radar product gold.",
    "",
    `- Merge scenarios: ${scenarios.length}`,
    `- Projects: ${new Set(scenarios.map((scenario) => scenario.project)).size}`,
    `- Change pairs: ${changes.length}`,
    `- Source positive changes: ${positiveChanges.length}`,
    `- Source negative changes: ${changes.length - positiveChanges.length}`,
    `- Clean merge scenarios: ${clean.length}`,
    `- Clean source-positive changes awaiting product adjudication: ${eligiblePositiveChanges.length}`,
    `- Scenarios with mechanical conflict: ${count(scenarios, (scenario) => scenario.git.mechanicalMerge === "textual-conflict")}`,
    `- Unavailable scenarios: ${count(scenarios, (scenario) => scenario.git.mechanicalMerge === "unavailable")}`,
    "",
    "## Product-gold gate",
    "",
    "A source positive is accepted only if it is mechanically clean, each parent has an independently supported expectation, the merged result violates one expectation, and the behavior is not an intended union. ANTLR-style additive keyword/list growth is therefore not automatically a product conflict.",
    "",
  ].join("\n");
}

async function main() {
  const papersRepo = resolve(papersRepoArg);
  const outputDir = resolve(outputArg);
  const csv = await command("git", ["-C", papersRepo, "show", `HEAD:${CSV_PATH}`]);
  if (csv.code !== 0) throw new Error(`cannot read SAM CSV: ${csv.stderr || csv.stdout}`);
  const rows = parseCsv(csv.stdout);
  const groups = new Map();
  for (const row of rows) {
    const project = cleanProject(row.Project);
    const key = `${project}@${row.Commit}`;
    const group = groups.get(key) || { project, commit: row.Commit, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  const byProject = new Map();
  for (const group of groups.values()) {
    const entries = byProject.get(group.project) || [];
    entries.push(group);
    byProject.set(group.project, entries);
  }
  const cacheRoot = resolve(".cache", "history");
  await Promise.all([mkdir(cacheRoot, { recursive: true }), mkdir(outputDir, { recursive: true })]);
  const projectQueue = [...byProject.entries()];
  const scenarios = [];
  const workers = Array.from({ length: Math.min(4, projectQueue.length) }, async () => {
    while (projectQueue.length) {
      const [project, entries] = projectQueue.shift();
      let repoDir;
      try { repoDir = await ensureRepository(cacheRoot, project); }
      catch (error) {
        scenarios.push(...entries.map((entry) => unavailableScenario(project, entry.commit, entry.rows, error.message)));
        continue;
      }
      const fetched = await command("git", ["-C", repoDir, "fetch", "--force", "--no-tags", "--filter=blob:none", "origin", ...entries.map((entry) => entry.commit)]);
      if (fetched.code !== 0) {
        scenarios.push(...entries.map((entry) => unavailableScenario(project, entry.commit, entry.rows, fetched.stderr || fetched.stdout)));
        continue;
      }
      for (const entry of entries) scenarios.push(await inspectScenario(repoDir, project, entry.commit, entry.rows));
    }
  });
  await Promise.all(workers);
  scenarios.sort((left, right) => left.project.localeCompare(right.project) || left.mergeCommit.localeCompare(right.mergeCommit));
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const changes = rows.map((row) => changeRecord(row, scenarioById.get(`${cleanProject(row.Project)}@${row.Commit}`)))
    .sort((left, right) => left.project.localeCompare(right.project) || left.caseId.localeCompare(right.caseId));
  await Promise.all([
    writeFile(join(outputDir, "scenarios.jsonl"), jsonl(scenarios)),
    writeFile(join(outputDir, "changes.jsonl"), jsonl(changes)),
    writeFile(join(outputDir, "report.md"), report(scenarios, changes)),
    writeFile(join(outputDir, "run.json"), `${JSON.stringify({
      schemaVersion: "sam-import-run-v0.1", generatedAt: new Date().toISOString(), papersRepo, csvPath: CSV_PATH,
      scenarioCount: scenarios.length, changeCount: changes.length,
    }, null, 2)}\n`),
  ]);
  console.log(`SAM import complete: ${outputDir}`);
  console.log(`${scenarios.length} scenarios · ${changes.length} changes · ${changes.filter((change) => change.sourceLabel === "local-interference" && change.semanticEligibility === "candidate").length} clean source-positive candidates`);
}

main().catch((error) => {
  console.error(`SAM import: ${error.message}`);
  process.exitCode = 1;
});
