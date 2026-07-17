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
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`1부터 ${maximum} 사이의 정수가 필요합니다.`);
  return parsed;
}

function requestedLanguage(raw) {
  if (!raw) return null;
  const aliases = { js: "javascript", py: "python", ts: "typescript" };
  const language = aliases[String(raw).trim().toLowerCase()] || String(raw).trim().toLowerCase();
  if (!SUPPORTED_LANGUAGES.includes(language)) throw new Error(`지원하지 않는 --language 값입니다: ${raw}. 사용 가능: ${SUPPORTED_LANGUAGES.join(", ")}`);
  return language;
}

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

function report(run, mined) {
  const lines = [
    `# ${run.repository} history-backed candidate mining`,
    "",
    "> fixing PR은 positive 정답이 아니라 원인 PR 쌍을 찾기 위한 anchor다. 모든 candidate는 4-state 실행 검증 전까지 unlabeled다.",
    "",
    `- 실행: ${run.generatedAt}`,
    `- pipeline: ${run.pipelineVersion}`,
    `- merged PR 수집: ${run.selection.fetchedMerged}개`,
    `- 언어 필터 후: ${run.selection.analyzedMerged}개`,
    `- fix/revert anchor: ${mined.fixes.length}개`,
    `- possible pair regression: ${mined.candidates.length}개`,
    `- matched control: ${mined.controls.length}개`,
    "",
    "## Possible pair regressions",
    "",
  ];
  if (!mined.candidates.length) lines.push("- 이번 범위에서는 두 prior PR과 연결되는 fixing anchor를 찾지 못했습니다.");
  for (const item of mined.candidates) {
    const causes = item.causes.map((pr) => `[#${pr.number}](${pr.url})`).join(" × ");
    const fix = `[#${item.fixingPullRequest.number}](${item.fixingPullRequest.url})`;
    lines.push(`- ${causes} → fix ${fix}: ${item.rankingSignals.join(", ") || "file proximity"}`);
  }
  lines.push("", "## Matched controls", "");
  if (!mined.controls.length) lines.push("- 없음");
  for (const item of mined.controls) lines.push(`- ${item.causes.map((pr) => `[#${pr.number}](${pr.url})`).join(" × ")}: ${item.evidence.filesSharedByAAndB.join(", ")}`);
  lines.push("", "## Required adjudication", "", "1. 공통 historical base에서 A-only/B-only/A+B를 재구성한다.", "2. A와 B가 각각 단독으로 정상인지 확인한다.", "3. A+B가 textually clean인지 확인한다.", "4. fixing PR의 회귀 테스트가 A+B에서 실패하고 fixing commit 적용 후 통과하는지 확인한다.", "5. 조건을 만족하지 않으면 positive로 세지 않는다.", "");
  return lines.join("\n");
}

async function main() {
  if (!positional) throw new Error("owner/repository를 입력하세요.");
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
  if (selected.length < 3) throw new Error("언어 필터 후 merged PR이 3개 미만입니다.");
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
