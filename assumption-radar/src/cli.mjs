#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fetchOpenPullRequests, parseRepository } from "./github.mjs";
import { finishAnalysis } from "./analyzer.mjs";
import { analyzeWithAI } from "./ai.mjs";
import { prepareAnalysisPipeline } from "./pipeline.mjs";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const positional = args.find((arg, index) => !arg.startsWith("-") && (index === 0 || !args[index - 1].startsWith("--")));

function help() {
  console.log(`Assumption Radar CLI

Usage:
  npm run scan -- owner/repository [--limit 20] [--preflight] [--ai] [--ai-provider openai|anthropic] [--json] [--fail-on conflict]
  npm run scan -- --demo [--json]

Environment:
  GITHUB_TOKEN     private repository access / higher API limits
  OPENAI_API_KEY   enables --ai
  ANTHROPIC_API_KEY enables --ai with --ai-provider anthropic
  OPENAI_MODEL     defaults to gpt-5.6-terra
  ANTHROPIC_MODEL  defaults to claude-opus-4-8`);
}

function printReport(result, repository) {
  console.log(`\nASSUMPTION RADAR · ${repository}`);
  console.log(`${"─".repeat(68)}`);
  console.log(`${result.summary.prCount} open PR · ${result.summary.pairCount} pairs · ${result.summary.conflictCount} conflicts · ${result.summary.reviewCount} reviews`);
  console.log(`Verdict: ${result.summary.verdict}\n`);
  for (const conflict of result.findings) {
    const prs = conflict.prIds.map((id) => `#${result.prs.find((pr) => pr.id === id)?.number || id}`).join(" × ");
    console.log(`[${conflict.verdict.toUpperCase()} · ${conflict.basis}] ${prs}  ${conflict.title}`);
    console.log(`  ${conflict.summary}`);
    console.log(`  → ${conflict.recommendation}\n`);
  }
}

async function main() {
  if (has("--help") || has("-h")) return help();
  let prs;
  let repository;
  if (has("--demo")) {
    const demoPath = fileURLToPath(new URL("../demo/synthetic-prs.json", import.meta.url));
    prs = JSON.parse(await readFile(demoPath, "utf8"));
    repository = "acme/commerce (demo)";
  } else {
    if (!positional) throw new Error("owner/repository를 입력하거나 --demo를 사용하세요.");
    repository = parseRepository(positional);
    const limit = Math.max(2, Math.min(100, Number(value("--limit")) || 20));
    prs = await fetchOpenPullRequests(repository, process.env.GITHUB_TOKEN, { limit });
  }
  if (prs.length < 2) throw new Error("분석할 open PR이 2개 이상 필요합니다.");
  const pipeline = await prepareAnalysisPipeline(prs, { repository: has("--demo") ? null : repository, useMergePreflight: has("--preflight") });
  const prepared = pipeline.prepared;
  const aiConflicts = has("--ai") ? await analyzeWithAI(prepared, { aiProvider: value("--ai-provider") }) : [];
  const result = { ...finishAnalysis(prepared, aiConflicts), repository, mode: aiConflicts.length ? "ai+heuristic" : "heuristic", preflight: pipeline.preflight };
  if (has("--json")) console.log(JSON.stringify(result, null, 2));
  else printReport(result, repository);

  const threshold = value("--fail-on");
  if (threshold && !["conflict", "review"].includes(threshold)) throw new Error("--fail-on은 conflict 또는 review여야 합니다.");
  if (threshold === "conflict" && result.findings.some((item) => item.verdict === "conflict")) process.exitCode = 2;
  if (threshold === "review" && result.findings.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`Assumption Radar: ${error.message}`);
  process.exitCode = 1;
});
