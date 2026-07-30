#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SUPPORTED_LANGUAGES } from "./adapters/registry.mjs";
import { fetchMergedPullRequests, parseRepository } from "./github.mjs";
import { mineHistoryCandidates, touchesLanguage } from "./history-mining.mjs";

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const positional = args.find((arg, index) => !arg.startsWith("-") && (index === 0 || !args[index - 1].startsWith("--")));

function positiveInteger(raw, fallback, maximum) {
  const parsed = Number(raw ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`Expected an integer between 1 and ${maximum}.`);
  return parsed;
}

function requestedLanguage(raw) {
  if (!raw) return null;
  const aliases = { js: "javascript", py: "python", ts: "typescript" };
  const language = aliases[String(raw).trim().toLowerCase()] || String(raw).trim().toLowerCase();
  if (!SUPPORTED_LANGUAGES.includes(language)) throw new Error(`Unsupported --language value: ${raw}. Available values: ${SUPPORTED_LANGUAGES.join(", ")}`);
  return language;
}

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

function report(run, mined) {
  const lines = [
    `# ${run.repository} history-backed candidate mining`,
    "",
    "> A fixing PR is an anchor for locating a possible causal PR pair, not a positive label. Every candidate remains unlabeled until four-state execution verification.",
    "",
    `- Generated: ${run.generatedAt}`,
    `- pipeline: ${run.pipelineVersion}`,
    `- Fetched merged PRs: ${run.selection.fetchedMerged}`,
    `- PRs after language filter: ${run.selection.analyzedMerged}`,
    `- Fix or revert anchors: ${mined.fixes.length}`,
    `- Possible pair regressions: ${mined.candidates.length}`,
    `- Matched controls: ${mined.controls.length}`,
    "",
    "## Possible pair regressions",
    "",
  ];
  if (!mined.candidates.length) lines.push("- No fixing anchor linked to two prior PRs was found in this range.");
  for (const item of mined.candidates) {
    const causes = item.causes.map((pr) => `[#${pr.number}](${pr.url})`).join(" × ");
    const fix = `[#${item.fixingPullRequest.number}](${item.fixingPullRequest.url})`;
    lines.push(`- ${causes} → fix ${fix}: ${item.rankingSignals.join(", ") || "file proximity"}`);
  }
  lines.push("", "## Matched controls", "");
  if (!mined.controls.length) lines.push("- None");
  for (const item of mined.controls) lines.push(`- ${item.causes.map((pr) => `[#${pr.number}](${pr.url})`).join(" × ")}: ${item.evidence.filesSharedByAAndB.join(", ")}`);
  lines.push("", "## Required adjudication", "", "1. Reconstruct A-only, B-only, and A+B from a shared historical base.", "2. Verify that A and B each pass independently.", "3. Verify that A+B is textually clean.", "4. Verify that the fixing PR's regression test fails on A+B and passes after applying the fixing commit.", "5. Do not count the case as positive unless every condition is satisfied.", "");
  return lines.join("\n");
}

async function main() {
  if (!positional) throw new Error("Enter owner/repository.");
  const repository = parseRepository(positional);
  const language = requestedLanguage(value("--language"));
  const mergedLimit = positiveInteger(value("--merged-prs"), 300, 500);
  const fixWindowDays = positiveInteger(value("--fix-window-days"), 90, 730);
  const candidateLimit = positiveInteger(value("--candidate-limit"), 30, 200);
  const controlCount = positiveInteger(value("--controls"), 20, 200);
  const perFixLimit = positiveInteger(value("--per-fix-limit"), 3, 20);
  const timestamp = new Date().toISOString();
  const slug = repository.replace("/", "__");
  const outputDir = resolve(value("--output") || join("benchmarks", "history-candidates", `${slug}-${timestamp.replace(/[:.]/g, "-")}`));

  const fetched = await fetchMergedPullRequests(repository, process.env.GITHUB_TOKEN, { limit: mergedLimit });
  const selected = fetched.filter((pr) => touchesLanguage(pr, language));
  if (selected.length < 3) throw new Error("Fewer than three merged PRs remain after language filtering.");
  const mined = mineHistoryCandidates(repository, selected, { fixWindowDays, candidateLimit, controlCount, perFixLimit });
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const run = {
    schemaVersion: "history-mining-v0.1",
    generatedAt: timestamp,
    repository,
    pipelineVersion: packageJson.version,
    selection: {
      requestedMerged: mergedLimit,
      fetchedMerged: fetched.length,
      analyzedMerged: selected.length,
      language,
      fixWindowDays,
      candidateLimit,
      controlCount,
      perFixLimit,
      ordering: "merged-desc",
    },
    summary: {
      fixAnchors: mined.fixes.length,
      positiveCandidates: mined.candidates.length,
      matchedControls: mined.controls.length,
      labelQueue: mined.queue.length,
    },
    artifacts: {
      mergedPullRequests: "merged-prs.jsonl",
      fixes: "fixes.jsonl",
      candidates: "positive-candidates.jsonl",
      controls: "control-candidates.jsonl",
      labelQueue: "label-queue.jsonl",
      report: "report.md",
    },
  };

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`),
    writeFile(join(outputDir, "merged-prs.jsonl"), jsonl(selected)),
    writeFile(join(outputDir, "fixes.jsonl"), jsonl(mined.fixes)),
    writeFile(join(outputDir, "positive-candidates.jsonl"), jsonl(mined.candidates)),
    writeFile(join(outputDir, "control-candidates.jsonl"), jsonl(mined.controls)),
    writeFile(join(outputDir, "label-queue.jsonl"), jsonl(mined.queue)),
    writeFile(join(outputDir, "report.md"), report(run, mined)),
  ]);

  console.log(`History mining complete: ${outputDir}`);
  console.log(`${selected.length} merged ${language || "code"} PR · ${mined.fixes.length} fix anchors · ${mined.candidates.length} pair candidates · ${mined.controls.length} controls`);
}

main().catch((error) => {
  console.error(`History mining: ${error.message}`);
  process.exitCode = 1;
});
