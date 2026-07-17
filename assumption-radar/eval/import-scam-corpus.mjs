#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseMergeTreeResult } from "../src/preflight.mjs";

const [sourceArg = ".cache/scam2023/extracted/merge-validation-paper-data/case-studies/merges.csv", outputArg = "benchmarks/semantic-clean-v0.1/scam-v0.1"] = process.argv.slice(2);

const REPOSITORY_OVERRIDES = new Map([
  ["resty-gwt-resty-gwt", "resty-gwt/resty-gwt"],
  ["spring-cloud-spring-cloud-config", "spring-cloud/spring-cloud-config"],
]);

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

async function exists(path) {
  try { await access(path); return true; }
  catch { return false; }
}

function projectCandidates(slug) {
  const override = REPOSITORY_OVERRIDES.get(slug);
  const candidates = override ? [override] : [];
  for (let index = slug.indexOf("-"); index >= 0; index = slug.indexOf("-", index + 1)) {
    candidates.push(`${slug.slice(0, index)}/${slug.slice(index + 1)}`);
  }
  return [...new Set(candidates)];
}

async function ensureRepository(cacheRoot, slug, refs) {
  const candidates = projectCandidates(slug);
  for (const project of candidates) {
    const repoDir = join(cacheRoot, `${project.replaceAll("/", "__")}.git`);
    if (!await exists(join(repoDir, "HEAD"))) {
      const init = await command("git", ["init", "--bare", repoDir]);
      if (init.code !== 0) continue;
      const remote = await command("git", ["-C", repoDir, "remote", "add", "origin", `https://github.com/${project}.git`]);
      if (remote.code !== 0) continue;
    }
    const fetch = await command("git", ["-C", repoDir, "fetch", "--force", "--no-tags", "--filter=blob:none", "origin", ...refs]);
    if (fetch.code === 0) return { repoDir, project };
  }
  throw new Error(`no GitHub repository candidate contained all requested refs: ${candidates.join(", ")}`);
}

async function inspect(repoDir, project, row) {
  const show = await command("git", ["-C", repoDir, "show", "-s", "--format=%H%n%P%n%T%n%s", row.merge]);
  if (show.code !== 0) return unavailable(row, project, show.stderr || show.stdout);
  const [commit, parentsLine = "", recordedTreeOid = "", subject = ""] = show.stdout.trim().split(/\r?\n/);
  const parents = parentsLine.split(/\s+/).filter(Boolean);
  if (parents.length !== 2) return unavailable(row, project, `expected two parents, got ${parents.length}`);
  const base = await command("git", ["-C", repoDir, "merge-base", parents[0], parents[1]]);
  const merge = await command("git", ["-C", repoDir, "merge-tree", "--write-tree", "--name-only", "--messages", parents[0], parents[1]]);
  const parsed = parseMergeTreeResult(merge);
  const bugfix = row.bugfix ? await command("git", ["-C", repoDir, "merge-base", "--is-ancestor", row.merge, row.bugfix]) : { code: 1 };
  const fixSummary = row.bugfix ? await command("git", ["-C", repoDir, "show", "-s", "--format=%H%n%s", row.bugfix]) : { code: 1, stdout: "" };
  return {
    schemaVersion: "scam-history-candidate-v0.1",
    caseId: `${project}@${row.merge}`,
    sourceProjectSlug: row.project,
    project,
    mergeCommit: row.merge,
    fixingCommit: row.bugfix || null,
    sourceLabel: row.useful === "1" ? "reviewed-merge-induced-defect" : row.useful === "0.5" ? "uncertain" : "reviewed-negative",
    sourceRationale: row.why,
    source: {
      corpus: "Symbolic Execution to Detect Semantic Merge Conflicts (SCAM 2023)",
      csvPath: "merge-validation-paper-data/case-studies/merges.csv",
      sourceUseful: row.useful,
    },
    git: {
      verification: commit === row.merge && base.code === 0 ? "verified-refs" : "ref-mismatch",
      subject,
      parents,
      base: base.stdout.trim() || null,
      mechanicalMerge: parsed.status,
      conflictPaths: parsed.conflictPaths,
      conflictMessages: parsed.messages,
      automaticTreeOid: parsed.treeOid,
      recordedTreeOid,
      automaticTreeMatchesRecordedMerge: parsed.status === "clean" && parsed.treeOid === recordedTreeOid,
      fixingCommitIsDescendant: bugfix.code === 0,
      fixingCommitSubject: fixSummary.stdout.trim().split(/\r?\n/)[1] || null,
      error: parsed.error || null,
    },
    semanticEligibility: commit === row.merge && parsed.status === "clean" && bugfix.code === 0 ? "candidate" : "excluded",
    productGold: {
      status: "unlabeled",
      relationship: null,
      evidenceGrade: null,
      rationale: null,
      evidenceRefs: row.bugfix ? [`commit:${row.bugfix}`] : [],
    },
  };
}

function unavailable(row, project, error) {
  return {
    schemaVersion: "scam-history-candidate-v0.1",
    caseId: `${project || row.project}@${row.merge}`,
    sourceProjectSlug: row.project,
    project: project || null,
    mergeCommit: row.merge,
    fixingCommit: row.bugfix || null,
    sourceLabel: row.useful === "1" ? "reviewed-merge-induced-defect" : row.useful === "0.5" ? "uncertain" : "reviewed-negative",
    sourceRationale: row.why,
    source: { corpus: "Symbolic Execution to Detect Semantic Merge Conflicts (SCAM 2023)", csvPath: "merge-validation-paper-data/case-studies/merges.csv", sourceUseful: row.useful },
    git: { verification: "unavailable", parents: [], base: null, mechanicalMerge: "unavailable", conflictPaths: [], conflictMessages: [], fixingCommitIsDescendant: false, error: String(error).trim().slice(0, 1000) },
    semanticEligibility: "excluded",
    productGold: { status: "unlabeled", relationship: null, evidenceGrade: null, rationale: null, evidenceRefs: [] },
  };
}

function chooseRows(rows) {
  const positives = rows.filter((row) => row.useful === "1");
  const positiveProjects = new Set(positives.map((row) => row.project));
  const controls = rows.filter((row) => row.useful === "0" && positiveProjects.has(row.project));
  return [...positives, ...controls];
}

function report(records, sourceRows) {
  const positives = records.filter((record) => record.sourceLabel === "reviewed-merge-induced-defect");
  const negatives = records.filter((record) => record.sourceLabel === "reviewed-negative");
  const eligiblePositives = positives.filter((record) => record.semanticEligibility === "candidate");
  const eligibleNegatives = negatives.filter((record) => record.semanticEligibility === "candidate");
  return [
    "# SCAM 2023 historical candidate import",
    "",
    "> Source labels come from post-merge fixing-commit inspection. They are candidate evidence, not Assumption Radar product gold.",
    "",
    `- Source rows: ${sourceRows.length}`,
    `- Imported reviewed-positive rows: ${positives.length}`,
    `- Imported same-project reviewed-negative controls: ${negatives.length}`,
    `- Mechanically clean positive candidates: ${eligiblePositives.length}`,
    `- Mechanically clean negative candidates: ${eligibleNegatives.length}`,
    `- Projects represented: ${new Set(records.map((record) => record.project).filter(Boolean)).size}`,
    `- Textual-conflict positives excluded: ${positives.filter((record) => record.git.mechanicalMerge === "textual-conflict").length}`,
    `- Unavailable positives: ${positives.filter((record) => record.git.mechanicalMerge === "unavailable").length}`,
    "",
    "## Product-gold gate",
    "",
    "A clean source-positive still requires independent review of the two parent expectations and the fixing diff. Compiler-detected integration failures count as clean-merge semantic conflicts, but accidental merge-resolution loss and single-parent bugs do not.",
    "",
  ].join("\n");
}

async function main() {
  const sourcePath = resolve(sourceArg);
  const outputDir = resolve(outputArg);
  const rows = parseCsv(await readFile(sourcePath, "utf8"));
  const selected = chooseRows(rows);
  const groups = new Map();
  for (const row of selected) {
    const values = groups.get(row.project) || [];
    values.push(row);
    groups.set(row.project, values);
  }
  const cacheRoot = resolve(".cache", "scam-history");
  await Promise.all([mkdir(cacheRoot, { recursive: true }), mkdir(outputDir, { recursive: true })]);
  const queue = [...groups.entries()];
  const records = [];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const [slug, projectRows] = queue.shift();
      let repository;
      try {
        const probe = projectRows.find((row) => row.useful === "1") || projectRows[0];
        repository = await ensureRepository(cacheRoot, slug, [probe.merge, probe.bugfix].filter(Boolean));
      } catch (error) {
        records.push(...projectRows.map((row) => unavailable(row, null, error.message)));
        continue;
      }
      for (const row of projectRows) {
        const fetched = await command("git", ["-C", repository.repoDir, "fetch", "--force", "--no-tags", "--filter=blob:none", "origin", ...[row.merge, row.bugfix].filter(Boolean)]);
        records.push(fetched.code === 0
          ? await inspect(repository.repoDir, repository.project, row)
          : unavailable(row, repository.project, fetched.stderr || fetched.stdout));
      }
    }
  });
  await Promise.all(workers);
  records.sort((left, right) => (left.project || "").localeCompare(right.project || "") || left.mergeCommit.localeCompare(right.mergeCommit));
  await Promise.all([
    writeFile(join(outputDir, "candidates.jsonl"), jsonl(records)),
    writeFile(join(outputDir, "report.md"), report(records, rows)),
    writeFile(join(outputDir, "run.json"), `${JSON.stringify({ schemaVersion: "scam-import-run-v0.1", generatedAt: new Date().toISOString(), sourcePath, sourceRowCount: rows.length, importedCount: records.length }, null, 2)}\n`),
  ]);
  const cleanPositive = records.filter((record) => record.sourceLabel === "reviewed-merge-induced-defect" && record.semanticEligibility === "candidate").length;
  console.log(`SCAM import complete: ${outputDir}`);
  console.log(`${records.length} imported · ${cleanPositive} clean reviewed-positive candidates`);
}

main().catch((error) => {
  console.error(`SCAM import: ${error.message}`);
  process.exitCode = 1;
});
