#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fetchPullRequest, fetchPullRequestsForCommit, parseRepository } from "./github.mjs";
import { isLikelyFix, referencedPullRequests } from "./history-mining.mjs";
import { traceFixLineage } from "./history-lineage.mjs";

const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const repository = parseRepository(args[0]);
const input = resolve(value("--input") || "");
const repoDir = resolve(value("--repo-dir") || "");
const outputDir = resolve(value("--output") || join("benchmarks", "history-lineage", `${repository.replace("/", "__")}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const limit = Math.max(1, Math.min(500, Number(value("--limit")) || 200));
const requestedFixes = new Set(String(value("--fixes") || "").split(",").filter(Boolean).map(Number));
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");

async function main() {
  if (!input || !repoDir) throw new Error("--input merged-prs.jsonl과 --repo-dir bare repository가 필요합니다.");
  const rows = (await readFile(input, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  const fixes = rows.filter(isLikelyFix)
    .filter((fix) => !requestedFixes.size || requestedFixes.has(fix.number))
    .slice(0, limit);
  const cache = new Map(rows.map((pr) => [pr.number, pr]));
  const fetchPull = async (repo, number) => {
    if (!cache.has(number)) cache.set(number, await fetchPullRequest(repo, number, process.env.GITHUB_TOKEN));
    return cache.get(number);
  };
  const traces = [];
  for (const [index, fix] of fixes.entries()) {
    console.log(`trace ${index + 1}/${fixes.length}: #${fix.number}`);
    const trace = await traceFixLineage({
      repository, repoDir, fix, referencedNumbers: referencedPullRequests(fix), fetchPull,
      fetchPullsForCommit: (repo, sha) => fetchPullRequestsForCommit(repo, sha, process.env.GITHUB_TOKEN),
    });
    traces.push(trace);
  }
  const candidates = traces.flatMap((trace) => trace.candidates);
  const exclusions = traces.flatMap((trace) => trace.exclusions);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, "traces.jsonl"), jsonl(traces)),
    writeFile(join(outputDir, "candidates.jsonl"), jsonl(candidates)),
    writeFile(join(outputDir, "exclusions.jsonl"), jsonl(exclusions)),
    writeFile(join(outputDir, "run.json"), `${JSON.stringify({ schemaVersion: "history-lineage-run-v0.1", generatedAt: new Date().toISOString(), repository, input, repoDir, fixes: fixes.length, candidates: candidates.length, exclusions: exclusions.length }, null, 2)}\n`),
  ]);
  console.log(`History lineage complete: ${outputDir}`);
  console.log(`${fixes.length} fixes · ${candidates.length} independent pair candidates · ${exclusions.length} excluded pairs`);
}

main().catch((error) => { console.error(`History lineage: ${error.stack || error.message}`); process.exitCode = 1; });
