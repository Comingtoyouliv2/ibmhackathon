#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fetchOpenPullRequestMetadata, fetchOpenPullRequests, parseRepository } from "./github.mjs";
import { finishAnalysis } from "./analyzer.mjs";
import { prepareAnalysisPipeline } from "./pipeline.mjs";
import { languageForFile, SUPPORTED_LANGUAGES } from "./adapters/registry.mjs";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const positional = args.find((arg, index) => !arg.startsWith("-") && (index === 0 || !args[index - 1].startsWith("--")));

function positiveInteger(raw, fallback, maximum) {
  const parsed = Number(raw ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`1부터 ${maximum} 사이의 정수가 필요합니다.`);
  return parsed;
}

function isCodePullRequest(pr) {
  const nonCode = /(?:^|\/)(?:docs?|news|doc\/whats_new)(?:\/|$)|\.(?:md|rst|png|jpe?g|gif|svg)$/i;
  return pr.files.some((file) => !nonCode.test(file.filename));
}

function requestedLanguage(raw) {
  if (!raw) return null;
  const aliases = { js: "javascript", py: "python", ts: "typescript" };
  const language = aliases[String(raw).trim().toLowerCase()] || String(raw).trim().toLowerCase();
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new Error(`지원하지 않는 --language 값입니다: ${raw}. 사용 가능: ${SUPPORTED_LANGUAGES.join(", ")}`);
  }
  return language;
}

function touchesLanguage(pr, language) {
  return !language || pr.files.some((file) => languageForFile(file.filename) === language);
}

function stableId(repository, numbers) {
  const pair = [...numbers].sort((a, b) => a - b);
  return `${repository}#${pair[0]}x${pair[1]}`;
}

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

async function readJsonl(path) {
  const content = await readFile(path, "utf8");
  return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function pairEntry(repository, comparison, prs, queueReason) {
  const pair = comparison.prIds.map((id) => prs.find((pr) => pr.id === id)).filter(Boolean);
  const numbers = pair.map((pr) => pr.number);
  return {
    caseId: stableId(repository, numbers),
    repository,
    pullRequests: pair.map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, head: pr.head, base: pr.base })),
    queueReason,
    prediction: {
      verdict: comparison.verdict,
      basis: comparison.basis,
      category: comparison.category,
      relationship: comparison.relationship || null,
      coordinationSubtype: comparison.coordinationSubtype || null,
      requiredAction: comparison.requiredAction || null,
      actionConfidence: comparison.actionConfidence || null,
      title: comparison.title,
      summary: comparison.summary,
      witnessTypes: comparison.witnesses.map((witness) => witness.type),
      witnesses: comparison.witnesses,
      evidence: comparison.evidence,
      explanationEvidence: comparison.explanationEvidence || [],
      validStrategies: comparison.validStrategies || [],
      invalidOutcome: comparison.invalidOutcome || null,
      protectedPrNumber: comparison.protectedPrNumber || null,
      mechanicalMerge: comparison.mechanicalMerge || null,
      semanticBenchmarkEligibility: comparison.semanticBenchmarkEligibility || null,
      observability: comparison.observability || null,
    },
    label: {
      status: "unlabeled",
      relationship: null,
      observability: null,
      evidenceRefs: [],
      notes: "",
    },
  };
}

function deterministicSample(comparisons, count) {
  return [...comparisons]
    .sort((a, b) => {
      const witnessDelta = b.witnesses.length - a.witnesses.length;
      if (witnessDelta) return witnessDelta;
      const left = createHash("sha1").update(a.key).digest("hex");
      const right = createHash("sha1").update(b.key).digest("hex");
      return left.localeCompare(right);
    })
    .slice(0, count);
}

function markdownReport(run, alerts, abstentions, controls, excluded, languageExcluded) {
  const lines = [
    `# ${run.repository} open-PR case mining`,
    "",
    "> 이 결과는 사람이 아직 검증하지 않은 label candidate입니다. conflict benchmark나 제품 정확도로 사용하지 않습니다.",
    "",
    `- 실행: ${run.generatedAt}`,
    `- 수집 PR: ${run.selection.fetched}개`,
    `- 입력 code PR: ${run.selection.analyzed}개`,
    `- stack collapse 후 PR: ${run.summary.prCount}개`,
    `- stack으로 접힌 PR: ${run.preflight?.suppressedPrNumbers?.length || 0}개`,
    `- 현재 base에 정상 적용된 PR: ${run.preflight?.basePreparedPrs || 0}개`,
    `- 현재 base와 먼저 충돌한 PR: ${run.preflight?.baseConflictPrNumbers?.length || 0}개`,
    `- 제외된 non-code PR: ${run.selection.excluded}개`,
    `- 언어 필터: ${run.selection.language || "없음"}`,
    `- 언어 필터로 제외된 PR: ${run.selection.languageExcluded}개`,
    `- 비교 pair: ${run.summary.pairCount}개`,
    `- conflict 후보: ${run.summary.conflictCount}개`,
    `- coordination 후보: ${run.summary.coordinationCount}개`,
    `- review 후보: ${run.summary.reviewCount}개`,
    `- insufficient 후보: ${run.summary.insufficientCount}개`,
    `- 사람이 볼 queue: ${alerts.length + abstentions.length + controls.length}개`,
    "",
    "## Radar alerts",
    "",
  ];
  if (!alerts.length) lines.push("- 이번 배치에서는 conflict/review witness가 발견되지 않았습니다.");
  for (const item of alerts) {
    const prs = item.pullRequests.map((pr) => `[#${pr.number}](${pr.url})`).join(" × ");
    lines.push(`- **${item.prediction.verdict}** ${prs}: ${item.prediction.title}`);
  }
  lines.push("", "## Abstention sample", "");
  if (!abstentions.length) lines.push("- 없음");
  for (const item of abstentions) lines.push(`- ${item.pullRequests.map((pr) => `#${pr.number}`).join(" × ")}: 추가 context 필요`);
  lines.push("", "## Independent control sample", "");
  for (const item of controls) lines.push(`- ${item.pullRequests.map((pr) => `[#${pr.number}](${pr.url})`).join(" × ")}`);
  lines.push("", "## Excluded non-code PR", "");
  if (!excluded.length) lines.push("- 없음");
  for (const pr of excluded) lines.push(`- [#${pr.number}](${pr.url}) ${pr.title}`);
  if (languageExcluded.length) {
    lines.push("", "## Excluded by language filter", "");
    for (const pr of languageExcluded) lines.push(`- [#${pr.number}](${pr.url}) ${pr.title}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  if (!positional) throw new Error("owner/repository를 입력하세요.");
  const repository = parseRepository(positional);
  const limit = positiveInteger(value("--limit"), 20, 1_000);
  const controlCount = positiveInteger(value("--controls"), 5, 50);
  const language = requestedLanguage(value("--language"));
  const sourcePath = value("--source");
  const timestamp = new Date().toISOString();
  const slug = repository.replace("/", "__");
  const outputDir = resolve(value("--output") || join("benchmarks", "candidates", `${slug}-${timestamp.replace(/[:.]/g, "-")}`));

  let fetched = sourcePath
    ? await readJsonl(resolve(sourcePath))
    : await fetchOpenPullRequests(repository, process.env.GITHUB_TOKEN, { limit });
  if (sourcePath && has("--refresh-base")) {
    const metadata = await fetchOpenPullRequestMetadata(repository, process.env.GITHUB_TOKEN, { limit: 100 });
    const byNumber = new Map(metadata.map((pr) => [pr.number, pr]));
    fetched = fetched.map((pr) => ({
      ...pr,
      baseSha: byNumber.get(pr.number)?.baseSha || pr.baseSha || null,
      headSha: byNumber.get(pr.number)?.headSha || pr.headSha || null,
    }));
  }
  const excluded = sourcePath ? [] : fetched.filter((pr) => !isCodePullRequest(pr));
  const codePullRequests = sourcePath ? fetched : fetched.filter(isCodePullRequest);
  const languageExcluded = codePullRequests.filter((pr) => !touchesLanguage(pr, language));
  const selected = codePullRequests.filter((pr) => touchesLanguage(pr, language));
  if (selected.length < 2) throw new Error("분석 가능한 code PR이 2개 미만입니다.");

  const pipeline = await prepareAnalysisPipeline(selected, { repository, useMergePreflight: has("--preflight") });
  const prepared = pipeline.prepared;
  const result = finishAnalysis(prepared);
  const alerts = prepared.comparisons
    .filter((item) => item.verdict === "conflict" || item.verdict === "coordination" || item.verdict === "review")
    .map((item) => pairEntry(repository, item, prepared.prs, item.verdict === "coordination" ? "merge-coordination" : "radar-alert"));
  const abstentions = deterministicSample(prepared.comparisons.filter((item) => item.verdict === "insufficient"), controlCount)
    .map((item) => pairEntry(repository, item, prepared.prs, "abstention-sample"));
  const controls = deterministicSample(prepared.comparisons.filter((item) => item.verdict === "independent"), controlCount)
    .map((item) => pairEntry(repository, item, prepared.prs, "independent-control"));

  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const run = {
    schemaVersion: "case-mining-v0.1",
    generatedAt: timestamp,
    repository,
    pipelineVersion: packageJson.version,
    mode: "heuristic",
    preflight: pipeline.preflight,
    selection: {
      requestedLimit: limit,
      fetched: fetched.length,
      analyzed: selected.length,
      excluded: excluded.length,
      language,
      languageExcluded: languageExcluded.length,
      ordering: "updated-desc",
      codeOnly: !sourcePath,
      inputMode: sourcePath ? "frozen-source-prs" : "github-open-prs",
      sourcePath: sourcePath ? resolve(sourcePath) : null,
      baseMetadataRefreshed: Boolean(sourcePath && has("--refresh-base")),
    },
    summary: result.summary,
    artifacts: {
      sourcePrs: "source-prs.jsonl",
      alerts: "alerts.jsonl",
      labelQueue: "label-queue.jsonl",
      report: "report.md",
    },
  };
  const queue = [...alerts, ...abstentions, ...controls];

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`),
    writeFile(join(outputDir, "source-prs.jsonl"), jsonl(selected)),
    writeFile(join(outputDir, "alerts.jsonl"), jsonl(alerts)),
    writeFile(join(outputDir, "label-queue.jsonl"), jsonl(queue)),
    writeFile(join(outputDir, "report.md"), markdownReport(run, alerts, abstentions, controls, excluded, languageExcluded)),
  ]);

  console.log(`Case mining complete: ${outputDir}`);
  console.log(`${selected.length} code PR · ${result.summary.pairCount} pairs · ${alerts.length} alerts · ${queue.length} label candidates`);
}

main().catch((error) => {
  console.error(`Case mining: ${error.message}`);
  process.exitCode = 1;
});
