#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fetchIssue, fetchPullRequest, fetchPullRequestsForCommit } from "./github.mjs";
import { candidateFamilyKey, closingIssueReferences, filterReplayFamilies, pullNumberFromMergeMessage } from "./replay-filter.mjs";

const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const input = resolve(args[0] || "");
const evidencePath = value("--evidence") ? resolve(value("--evidence")) : null;
const outputDir = resolve(value("--output-dir") || join("benchmarks", "replay-filter", new Date().toISOString().replace(/[:.]/g, "-")));
const useGitHub = args.includes("--github");
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
const readJsonl = async (path) => path
  ? (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse)
  : [];

async function githubEvidence(candidate) {
  const repository = candidate.repository;
  const mergeNumber = pullNumberFromMergeMessage(candidate.merge?.message || `${candidate.merge?.subject || ""}\n${candidate.merge?.body || ""}`);
  const fixNumber = pullNumberFromMergeMessage(candidate.fixingCommit?.message || `${candidate.fixingCommit?.subject || ""}\n${candidate.fixingCommit?.body || ""}`);
  const causePulls = [];
  if (mergeNumber) {
    try { causePulls.push(await fetchPullRequest(repository, mergeNumber)); } catch { /* unavailable PR metadata */ }
  }
  for (const sha of [...(candidate.evidence?.lineage?.sideACommits || []), ...(candidate.evidence?.lineage?.sideBCommits || [])]) {
    try { causePulls.push(...await fetchPullRequestsForCommit(repository, sha)); } catch { /* unavailable association */ }
  }
  const uniqueCauses = [...new Map(causePulls.map((pr) => [pr.number, pr])).values()];
  let fixPull = null;
  if (fixNumber) {
    try { fixPull = await fetchPullRequest(repository, fixNumber); } catch { /* unavailable PR metadata */ }
  }
  const issueReports = [];
  for (const reference of closingIssueReferences(`${fixPull?.title || ""}\n${fixPull?.body || ""}`, repository)) {
    try {
      const issue = await fetchIssue(reference.repository || repository, reference.number);
      if (!issue.isPullRequest) issueReports.push({
        repository: reference.repository || repository, number: issue.number, url: issue.url, title: issue.title, reportedAt: issue.createdAt,
        explicitlyLinked: true, symptomMatches: true,
      });
    } catch { /* stale or inaccessible issue reference */ }
  }
  return {
    schemaVersion: "counterfactual-replay-evidence-v0.1",
    familyKey: candidateFamilyKey(candidate),
    caseIds: [candidate.caseId],
    pairScope: uniqueCauses.length >= 2 ? "independent-prs" : "unknown",
    causes: uniqueCauses.map((pr) => ({ id: `PR-${pr.number}`, number: pr.number, url: pr.url, createdAt: pr.createdAt })),
    issueReports,
    states: {},
    source: "github-timeline-enrichment",
  };
}

function report(rows, inputPath) {
  const count = (classification) => rows.filter((row) => row.decision.classification === classification).length;
  return [
    "# Counterfactual replay filter",
    "",
    `- Input: \`${inputPath}\``,
    `- Raw candidates: ${rows.reduce((sum, row) => sum + row.memberCount, 0)}`,
    `- Independent families: ${rows.length}`,
    `- Pair-induced conflicts: ${count("pair-induced-conflict")}`,
    `- Compatible: ${count("compatible")}`,
    `- Pre-existing defects: ${count("pre-existing-defect")}`,
    `- Single-parent bugs: ${count("single-parent-a-bug") + count("single-parent-b-bug")}`,
    `- Insufficient/manual queue: ${count("insufficient")}`,
    "",
    "> Only independent-PR families with complete counterfactual evidence are eligible for pair benchmark metrics.",
    "",
  ].join("\n");
}

async function main() {
  if (!args[0]) throw new Error("A candidate JSONL path is required.");
  const candidates = await readJsonl(input);
  const evidence = await readJsonl(evidencePath);
  if (useGitHub) {
    for (const candidate of candidates) evidence.push(await githubEvidence(candidate));
  }
  const rows = filterReplayFamilies(candidates, evidence);
  const adjudicated = rows.filter((row) => row.decision.classification !== "insufficient");
  const review = rows.filter((row) => row.decision.classification === "insufficient");
  const controls = adjudicated.filter((row) => row.decision.historyMinerControl);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, "families.jsonl"), jsonl(rows)),
    writeFile(join(outputDir, "adjudicated.jsonl"), jsonl(adjudicated)),
    writeFile(join(outputDir, "history-miner-controls.jsonl"), jsonl(controls)),
    writeFile(join(outputDir, "review-queue.jsonl"), jsonl(review)),
    writeFile(join(outputDir, "report.md"), `${report(rows, input)}\n`),
    writeFile(join(outputDir, "run.json"), `${JSON.stringify({
      schemaVersion: "replay-filter-run-v0.1", generatedAt: new Date().toISOString(), input,
      evidencePath, useGitHub, rawCandidates: candidates.length, families: rows.length,
      adjudicated: adjudicated.length, reviewQueue: review.length,
    }, null, 2)}\n`),
  ]);
  console.log(`Replay filter complete: ${outputDir}`);
  console.log(`${candidates.length} raw candidates · ${rows.length} families · ${adjudicated.length} adjudicated · ${review.length} review`);
}

main().catch((error) => { console.error(`Replay filter: ${error.stack || error.message}`); process.exitCode = 1; });
