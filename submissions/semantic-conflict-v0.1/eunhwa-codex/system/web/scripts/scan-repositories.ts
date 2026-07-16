import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { analyzeRepository } from "../app/lib/github";

const repositories = process.argv.slice(2);
if (repositories.length === 0) throw new Error("Pass one or more owner/repository values");
const limit = process.env.SCAN_LIMIT ? Number(process.env.SCAN_LIMIT) : Infinity;
const token = process.env.GITHUB_TOKEN;
const startedAt = new Date().toISOString();
const results = [];

for (const repository of repositories) {
  console.log(`Scanning ${repository} (${Number.isFinite(limit) ? `latest ${limit}` : "all"} open PRs)...`);
  const result = await analyzeRepository(repository, token, limit);
  results.push(result);
  console.log(`  total=${result.totalOpenPrs} scanned=${result.scannedPrs} pair_merge_eligible=${result.pairMergeGatePrs} ci_passed=${result.eligibleGatePrs} analyzed=${result.eligiblePrs} git_candidates=${result.gitCandidates?.length ?? 0} semantic_candidates=${result.semanticCandidates?.length ?? result.candidates.length} verify=${result.needsVerification?.length ?? 0} conflicts=${result.conflicts.length} errors=${result.scanErrors.length}`);
}

const output = { startedAt, finishedAt: new Date().toISOString(), limit, results };
const artifactDir = path.resolve("artifacts");
fs.mkdirSync(artifactDir, { recursive: true });
const stamp = process.env.SCAN_DATE ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
const jsonPath = path.join(artifactDir, `oss-scan-${stamp}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));

const lines = ["# OSS PR-pair conflict scan", "", `Scanned: ${output.finishedAt}`, `Window: ${Number.isFinite(limit) ? `latest ${limit}` : "all"} open PRs per repository`, "", "| repository | total open | scanned | pair-merge eligible | CI passed | semantic analyzed | Git candidates | semantic candidates | conflicts | fetch errors |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|", ...results.map((r) => `| ${r.repository} | ${r.totalOpenPrs} | ${r.scannedPrs} | ${r.pairMergeGatePrs} | ${r.eligibleGatePrs} | ${r.eligiblePrs} | ${r.gitCandidates?.length ?? 0} | ${r.semanticCandidates?.length ?? r.candidates.length} | ${r.conflicts.length} | ${r.scanErrors.length} |`), ""];
for (const result of results) {
  lines.push(`## ${result.repository}`, "");
  if (result.conflicts.length === 0) lines.push("- No deterministic signature/call conflict detected in the scanned eligible window.");
  for (const conflict of result.conflicts) lines.push(`- #${conflict.a} x #${conflict.b}: ${conflict.rationale} (${conflict.sharedResources.join(", ")})`);
  if (result.needsVerification?.length) {
    lines.push("", "Needs merge verification:");
    for (const finding of result.needsVerification.slice(0, 20)) lines.push(`- #${finding.a} x #${finding.b}: ${finding.rationale} (${finding.sharedResources.join(", ")})`);
  }
  if ((result.semanticCandidates ?? result.candidates).length) {
    lines.push("", "Candidate pairs:");
    for (const candidate of (result.semanticCandidates ?? result.candidates).slice(0, 20)) lines.push(`- #${candidate.a} x #${candidate.b} [${candidate.candidateTier ?? "contract"}]: ${candidate.sharedResources.join(", ")}`);
  }
  const definitionChanges = result.cards.flatMap((card) => card.facts.filter((fact) => fact.kind === "definition_change").map((fact) => ({ card, fact })));
  if (definitionChanges.length) {
    lines.push("", "Unmatched contract changes (no eligible PR added the previous call shape):");
    for (const { card, fact } of definitionChanges) lines.push(`- #${card.pr} ${fact.resource}: arity ${fact.previousArity} -> ${fact.arity} (${card.url})`);
  }
  lines.push("");
}
const mdPath = path.join(artifactDir, `oss-scan-${stamp}.md`);
fs.writeFileSync(mdPath, lines.join("\n"));

let publishedOutput = output;
if (process.env.ENABLE_LLM_JUDGE === "1") {
  const tsx = path.resolve("node_modules/.bin/tsx");
  console.log("Verifying Git pair merges before selective LLM review...");
  const pairVerified = spawnSync(tsx, ["scripts/verify-pair-merges.ts", jsonPath], {
    cwd: process.cwd(), env: process.env, stdio: "inherit",
  });
  if (pairVerified.status !== 0) throw new Error(`Pair merge verification failed with exit ${pairVerified.status ?? "unknown"}`);
  console.log("Running selective LLM review for unresolved medium/weak and patch-interaction pairs...");
  const judged = spawnSync(tsx, ["scripts/judge-llm-artifact.ts", jsonPath], {
    cwd: process.cwd(), env: process.env, stdio: "inherit",
  });
  if (judged.status !== 0) throw new Error(`Selective LLM review failed with exit ${judged.status ?? "unknown"}`);
  publishedOutput = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as typeof output;
} else {
  console.log("Selective LLM review skipped. Set ENABLE_LLM_JUDGE=1 and an LLM API key to enable it.");
}

const publicPath = path.resolve("public/oss-scan-latest.json");
const importantResults = publishedOutput.results.map((result) => {
  const keep = new Set<number>();
  for (const pair of [...(result.semanticCandidates ?? result.candidates), ...(result.gitCandidates ?? []), ...result.conflicts, ...(result.needsVerification ?? [])]) { keep.add(pair.a); keep.add(pair.b); }
  for (const card of result.cards) if (card.facts.some((fact) => fact.kind === "definition_change")) keep.add(card.pr);
  return {
    ...result,
    excluded: [],
    cards: result.cards.filter((card) => keep.has(card.pr)),
    pairMergeCards: (result.pairMergeCards ?? result.cards).filter((card) => keep.has(card.pr)),
  };
});
fs.writeFileSync(publicPath, JSON.stringify({ ...publishedOutput, results: importantResults }, null, 2));
console.log(`Wrote ${jsonPath} and ${mdPath}`);
