#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareIntegratedAnalysis } from "../src/integrated.mjs";
import { DockerCombinedVerifier, loadVerificationProfiles } from "../src/docker-verifier.mjs";
import { GitMergeTreePreflight } from "../src/preflight.mjs";
import { buildExecutionProfiles, buildLiveErrorLedger } from "./live-exploration.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (flag, fallback = null) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : fallback; };
const readJsonl = async (path) => (await readFile(path, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
const jsonl = (rows) => rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
const pairKey = (numbers) => [...numbers].map(Number).sort((a, b) => a - b).join(":");

function snapshotFinding(snapshot, action) {
  return snapshot.findings.find((item) => item.logicalKey === action.logicalKey)
    || snapshot.explorationControls?.find((item) => item.logicalKey === action.logicalKey)
    || { logicalKey: action.logicalKey, prNumbers: action.prNumbers, verdict: action.predictedVerdict || action.verdict, basis: action.basis, source: action.source };
}

function stackExclusion(comparison, pairPrs, stack) {
  const ordered = [...pairPrs].sort((left, right) => Number(left.number) - Number(right.number));
  const verifiedAt = new Date().toISOString();
  return {
    key: comparison.key,
    prIds: ordered.map((pr) => String(pr.id)),
    prNumbers: ordered.map((pr) => Number(pr.number)),
    baseSha: ordered[0]?.baseSha || ordered[1]?.baseSha || null,
    headShaA: ordered[0]?.headSha || null,
    headShaB: ordered[1]?.headSha || null,
    combinedTreeSha: null,
    profile: null,
    profileSource: null,
    classification: {
      verdict: "excluded",
      reasonCode: "stacked-prs",
      semanticBenchmarkEligibility: "excluded",
      rationale: "두 PR은 독립 변경이 아니라 ancestor/descendant 스택이므로 pair-induced regression 표본에서 제외합니다.",
      evidence: [`PR #${stack.ancestorNumber} is an ancestor of PR #${stack.descendantNumber}`],
    },
    runs: [],
    impact: { summary: "독립 PR 쌍이 아니므로 실행 검증과 오류 장부 집계에서 제외했습니다." },
    verifiedAt,
  };
}

function preflightDisposition(comparison, pairPrs, inspection) {
  const ordered = [...pairPrs].sort((left, right) => Number(left.number) - Number(right.number));
  const excluded = ["textual-conflict", "base-conflict"].includes(inspection.status);
  const reasonCode = inspection.status === "textual-conflict" ? "mechanical-textual-conflict"
    : inspection.status === "base-conflict" ? "base-conflict" : "merge-preflight-unavailable";
  return {
    key: comparison.key,
    prIds: ordered.map((pr) => String(pr.id)),
    prNumbers: ordered.map((pr) => Number(pr.number)),
    baseSha: ordered[0]?.baseSha || ordered[1]?.baseSha || null,
    headShaA: ordered[0]?.headSha || null,
    headShaB: ordered[1]?.headSha || null,
    combinedTreeSha: inspection.treeOid || null,
    profile: null,
    profileSource: null,
    classification: {
      verdict: excluded ? "excluded" : "inconclusive",
      reasonCode,
      semanticBenchmarkEligibility: excluded ? "excluded" : "inconclusive",
      rationale: excluded
        ? "Git이 먼저 차단하는 기계적 충돌이므로 silent pair-induced regression 표본에서 제외합니다."
        : "merge-tree 결과를 만들지 못해 실행 검증을 보류합니다.",
      evidence: [...(inspection.conflictPaths || []), ...(inspection.messages || []), inspection.error].filter(Boolean).slice(0, 20),
    },
    runs: [],
    impact: { summary: excluded ? "기계적 Git 충돌로 제외했습니다." : "merge preflight가 불충분해 판정할 수 없습니다." },
    verifiedAt: new Date().toISOString(),
  };
}

function learningReport(results, ledger, errors) {
  const falseNegatives = ledger.filter((item) => item.errorType === "false-negative");
  const falsePositiveCandidates = ledger.filter((item) => item.errorType === "false-positive-candidate");
  const excluded = results.filter((item) => item.verification?.classification?.verdict === "excluded");
  const rows = ledger.length
    ? ledger.map((item) => `| ${item.id} | ${item.errorType} | ${item.pipelineStage} | ${item.rootCause} |`).join("\n")
    : "| - | - | - | - |";
  return [
    "# Live verification learning report",
    "",
    `- Executed or classified pairs: ${results.length}`,
    `- Retrieval false negatives: ${falseNegatives.length}`,
    `- False-positive candidates: ${falsePositiveCandidates.length}`,
    `- Excluded controls: ${excluded.length}`,
    `- Runner errors: ${errors.length}`,
    "",
    "| Pair | Error | Pipeline stage | Root cause |",
    "|---|---|---|---|",
    rows,
    "",
    "> A false-positive candidate is not a confirmed false positive until a human checks that the selected tests cover the claimed contract.",
    "",
  ].join("\n");
}

async function latest(root) {
  const names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  if (!names.length) throw new Error(`no run directories in ${root}`);
  return join(root, names[0]);
}

async function main() {
  const harness = resolve(value("--harness-run", await latest(join(ROOT, ".cache", "improvement-harness"))));
  const run = JSON.parse(await readFile(join(harness, "run.json"), "utf8"));
  const actions = await readJsonl(join(harness, "verification-actions.jsonl"));
  const profilePath = value("--verification-profile");
  const profiles = await loadVerificationProfiles(profilePath ? resolve(profilePath) : null);
  const outputRoot = resolve(value("--output-root", join(ROOT, ".cache", "live-verification-runs")));
  const executionProfileRoot = resolve(value("--execution-profile-root", join(ROOT, ".cache", "live-execution-profiles")));
  const output = join(outputRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(output, { recursive: true });
  const results = [];
  const errors = [];

  for (const liveRun of run.liveRuns || []) {
    const snapshot = JSON.parse(await readFile(join(liveRun, "snapshot.json"), "utf8"));
    const repositoryActions = actions.filter((action) => action.repository === snapshot.repository);
    if (!repositoryActions.length) continue;
    let liveInput;
    try { [liveInput] = await readJsonl(join(liveRun, "inputs.jsonl")); }
    catch {
      errors.push({ repository: snapshot.repository, error: "snapshot predates inputs.jsonl; rerun snapshot:live before executable verification" });
      continue;
    }
    const prepared = prepareIntegratedAnalysis(liveInput.prs);
    const byNumber = new Map(prepared.prs.map((pr) => [Number(pr.number), String(pr.id)]));
    const comparisonByNumbers = new Map(prepared.comparisons.map((comparison) => {
      const numbers = comparison.prIds.map((id) => prepared.prs.find((pr) => String(pr.id) === String(id))?.number).map(Number).sort((a, b) => a - b);
      return [numbers.join(":"), comparison];
    }));
    const preflightEngine = new GitMergeTreePreflight(snapshot.repository);
    const verifier = new DockerCombinedVerifier(snapshot.repository, { preflightEngine, profiles });
    try {
      await preflightEngine.initialize(prepared.prs);
      const stacks = await preflightEngine.findStacks(prepared.prs);
      const stacksByNumbers = new Map(stacks.map((stack) => [pairKey([stack.ancestorNumber, stack.descendantNumber]), stack]));
      const runnableActionCount = repositoryActions.filter((action) => !stacksByNumbers.has(pairKey(action.prNumbers))).length;
      const inspectionsByNumbers = new Map();
      const prsById = new Map(prepared.prs.map((pr) => [String(pr.id), pr]));
      if (runnableActionCount) {
        await preflightEngine.prepareBaseMerges(prepared.prs);
        for (const action of repositoryActions) {
          const key = pairKey(action.prNumbers);
          if (stacksByNumbers.has(key)) continue;
          const comparison = comparisonByNumbers.get(key);
          if (comparison) inspectionsByNumbers.set(key, await preflightEngine.inspectPair(comparison, prsById));
        }
        if ([...inspectionsByNumbers.values()].some((inspection) => inspection.status === "clean" && inspection.treeOid)) await verifier.assertDocker();
      }
      for (const action of repositoryActions) {
        const key = pairKey(action.prNumbers);
        const comparison = comparisonByNumbers.get(key);
        if (!comparison || action.prNumbers.some((number) => !byNumber.has(Number(number)))) {
          errors.push({ actionId: action.id, repository: snapshot.repository, error: "pair not present in immutable snapshot input" });
          continue;
        }
        const pairIds = new Set(action.prNumbers.map(Number));
        const finding = snapshotFinding(snapshot, action);
        const stack = stacksByNumbers.get(key);
        if (stack) {
          const pairPrs = prepared.prs.filter((pr) => pairIds.has(Number(pr.number)));
          results.push({
            schemaVersion: "live-verification-result-v0.1",
            actionId: action.id,
            repository: snapshot.repository,
            action,
            liveRun,
            input: { schemaVersion: "semantic-clean-input-v0.1", prs: liveInput.prs.filter((pr) => pairIds.has(Number(pr.number))) },
            finding,
            verification: stackExclusion(comparison, pairPrs, stack),
          });
          continue;
        }
        try {
          const inspection = inspectionsByNumbers.get(key);
          const verification = inspection.status === "clean" && inspection.treeOid
            ? await verifier.verifyPair(comparison, prsById, inspection)
            : preflightDisposition(comparison, prepared.prs.filter((pr) => pairIds.has(Number(pr.number))), inspection);
          results.push({
            schemaVersion: "live-verification-result-v0.1",
            actionId: action.id,
            repository: snapshot.repository,
            action,
            liveRun,
            input: { schemaVersion: "semantic-clean-input-v0.1", prs: liveInput.prs.filter((pr) => pairIds.has(Number(pr.number))) },
            finding,
            verification,
          });
        } catch (error) { errors.push({ actionId: action.id, repository: snapshot.repository, error: error.message }); }
      }
    } finally { await preflightEngine.cleanup?.().catch(() => {}); }
  }
  const errorLedger = buildLiveErrorLedger(results);
  const executionProfiles = buildExecutionProfiles(results);
  const report = learningReport(results, errorLedger, errors);
  await mkdir(executionProfileRoot, { recursive: true });
  await Promise.all([
    writeFile(join(output, "results.jsonl"), jsonl(results)),
    writeFile(join(output, "errors.jsonl"), jsonl(errors)),
    writeFile(join(output, "error-ledger.jsonl"), jsonl(errorLedger)),
    writeFile(join(output, "execution-profiles.jsonl"), jsonl(executionProfiles)),
    writeFile(join(output, "learning-report.md"), report),
    ...executionProfiles.map((profile) => writeFile(join(executionProfileRoot, `${profile.repository.replace("/", "__")}.json`), `${JSON.stringify(profile, null, 2)}\n`)),
    writeFile(join(output, "run.json"), `${JSON.stringify({ schemaVersion: "live-verification-run-v0.1", harness, generatedAt: new Date().toISOString(), resultCount: results.length, errorCount: errors.length, learningErrorCount: errorLedger.length, falseNegativeCount: errorLedger.filter((item) => item.errorType === "false-negative").length, falsePositiveCandidateCount: errorLedger.filter((item) => item.errorType === "false-positive-candidate").length, executionProfileCount: executionProfiles.length }, null, 2)}\n`),
  ]);
  console.log(`Verified: ${results.length}`);
  console.log(`Errors: ${errors.length}`);
  console.log(`Learning errors: ${errorLedger.length}`);
  console.log(`Saved: ${output}`);
  if (errors.length) process.exitCode = 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
