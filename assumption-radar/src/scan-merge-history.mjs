#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseRepository } from "./github.mjs";
import { scanMergeHistory } from "./merge-history.mjs";

const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const repository = parseRepository(args[0]);
const repoDir = resolve(value("--repo-dir") || "");
const ref = value("--ref") || "HEAD";
const outputDir = resolve(value("--output") || join("benchmarks", "merge-history", `${repository.replace("/", "__")}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const number = (flag, fallback) => Math.max(1, Number(value(flag)) || fallback);
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");

async function main() {
  if (!repoDir) throw new Error("--repo-dir must point to a bare repository.");
  const options = {
    commitLimit: number("--commit-limit", 2000),
    mergeLimit: number("--merge-limit", 200),
    fixWindowDays: number("--fix-window-days", 45),
    fixesPerMerge: number("--fixes-per-merge", 20),
  };
  const result = await scanMergeHistory({ repository, repoDir, ref, ...options });
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, "candidates.jsonl"), jsonl(result.candidates)),
    writeFile(join(outputDir, "review-candidates.jsonl"), jsonl(result.reviewCandidates)),
    writeFile(join(outputDir, "controls.jsonl"), jsonl(result.controls)),
    writeFile(join(outputDir, "exclusions.jsonl"), jsonl(result.exclusions)),
    writeFile(join(outputDir, "run.json"), `${JSON.stringify({
      schemaVersion: "merge-history-run-v0.1", generatedAt: new Date().toISOString(), repository, repoDir, ref,
      options,
      historyCount: result.historyCount, mergeCount: result.mergeCount, candidates: result.candidates.length,
      reviewCandidates: result.reviewCandidates.length,
      controls: result.controls.length, exclusions: result.exclusions.length,
    }, null, 2)}\n`),
  ]);
  console.log(`Merge history scan complete: ${outputDir}`);
  console.log(`${result.mergeCount} two-parent merges · ${result.candidates.length} both-parent candidates · ${result.reviewCandidates.length} replay candidates · ${result.controls.length} controls`);
}

main().catch((error) => { console.error(`Merge history scan: ${error.stack || error.message}`); process.exitCode = 1; });
