#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareAnalysis } from "../src/analyzer.mjs";
import { evaluateRecords } from "./evaluate.mjs";

const [
  rootArg = "benchmarks/semantic-clean-v0.1",
  outputArg = "benchmarks/semantic-clean-v0.1/frozen-v0.1",
  versionArg = "v0.6.0",
] = process.argv.slice(2);
const version = versionArg.startsWith("v") ? versionArg : `v${versionArg}`;
if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid benchmark version: ${versionArg}`);
const POSITIVE_EXCLUSIONS = new Set([
  "google/truth@2e4a23bebbce280861453c0d6f6f0a3dfd0e6dde",
  "welovecoding/editorconfig-netbeans@99578c4f5dc0112dcdd4a14a5d7f168ddaa4d4d5",
]);
const PRODUCT_HARD_NEGATIVE_SCENARIOS = new Map([
  ["antlr/antlr4@69ff2669eec265e25721dbc27cb00f6c381d0b41", "Both parents add different reserved words. The intended result is the union, so list-size growth is not a violated expectation."],
  ["unclebob/fitnesse@4d9ba9d221d879507440feb084fa7521b95111ec", "Both parents register different table types. The map is an extensibility registry and the intended result is the union."],
]);

function command(program, args, options = {}) {
  return new Promise((done) => {
    execFile(program, args, { timeout: options.timeout || 600_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout = "", stderr = "") => done({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
  });
}

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const readJsonl = async (path) => (await readFile(path, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
const unique = (values) => [...new Set(values)];

function parseDiff(text) {
  return text.split(/(?=^diff --git )/m).filter((section) => section.startsWith("diff --git ")).map((section) => {
    const lines = section.split("\n");
    const header = lines[0].match(/^diff --git a\/(.+) b\/(.+)$/);
    const oldPath = header?.[1] || "unknown";
    const newPath = header?.[2] || oldPath;
    const deleted = lines.some((line) => line.startsWith("deleted file mode"));
    const added = lines.some((line) => line.startsWith("new file mode"));
    const renamed = lines.some((line) => line.startsWith("rename from "));
    return {
      filename: deleted ? oldPath : newPath,
      ...(renamed ? { previousFilename: oldPath } : {}),
      status: deleted ? "removed" : added ? "added" : renamed ? "renamed" : "modified",
      patch: section,
    };
  });
}

async function parentInput(repoDir, project, base, parent, side) {
  const diff = await command("git", ["-C", repoDir, "diff", "--find-renames", "--unified=3", "--no-ext-diff", base, parent]);
  if (diff.code !== 0) throw new Error(`${project}@${parent}: cannot build diff: ${diff.stderr || diff.stdout}`);
  return {
    id: `${project}:${parent}:${side}`,
    number: side,
    title: `${project} historical parent ${side}`,
    url: `https://github.com/${project}/commit/${parent}`,
    headSha: parent,
    baseSha: base,
    files: parseDiff(diff.stdout),
  };
}

function positiveArchetype(rationale) {
  const value = rationale.toLowerCase();
  if (/both sides add|same method|same class constant|same name|duplicates/.test(value)) return "duplicate-addition";
  if (/rename|changed name/.test(value)) return "rename-vs-reference";
  if (/import/.test(value)) return "import-vs-use";
  if (/initiali[sz]/.test(value)) return "initialization-order";
  if (/signature|constructor|parameter|prototype|method call/.test(value)) return "signature-vs-callsite";
  if (/removes a class field/.test(value)) return "remove-vs-reference";
  return "behavioral-composition";
}

function negativeArchetype(rationale) {
  const value = rationale.toLowerCase();
  if (value.includes("refactor")) return "compatible-refactoring";
  if (value.includes("different object") || value.includes("different attribute")) return "compatible-state-partition";
  if (value.includes("logger") || value.includes("log")) return "compatible-side-effect";
  if (value.includes("union") || value.includes("register")) return "compatible-intended-union";
  return "compatible-control-flow";
}

function goldRecord({ id, project, mergeCommit, fixingCommit = null, git, gold, rationale, source, archetype }) {
  return {
    schemaVersion: "semantic-clean-gold-v0.1",
    id,
    repo: project,
    language: "Java",
    archetype,
    distance: "same-declaration-or-contract",
    difficulty: "hard",
    gold,
    goldRelationship: gold === "conflict" ? "coordination-required" : "compatible",
    goldRequiredAction: gold === "conflict" ? "reconcile-contract-before-merge" : null,
    semanticBenchmarkEligibility: "included",
    mechanicalMerge: "clean",
    baseSha: git.base,
    parentShas: git.parents,
    mergeCommit,
    fixingCommit,
    observability: { mechanical: "merge-tree", semantic: "repository-context" },
    evidenceGrade: "contract-backed",
    rationale,
    source,
    goldEvidence: [
      { id: "E1", kind: "merge-tree", ref: `tree:${git.automaticTreeOid}`, summary: "The two parents merge without textual conflicts." },
      ...(fixingCommit ? [{ id: "E2", kind: "fixing-commit", ref: `commit:${fixingCommit}`, summary: "A descendant commit repairs the integration defect identified in the source review." }] : []),
      { id: fixingCommit ? "E3" : "E2", kind: "contract", ref: "source-review", summary: rationale },
    ],
    adjudication: {
      status: "verified",
      date: "2026-07-15",
      basis: fixingCommit
        ? ["mechanical-replay", "recorded-tree-match", "fixing-commit-causal-analysis", "product-constitution-review"]
        : ["mechanical-replay", "manual-change-pair-review", "product-constitution-review"],
    },
  };
}

function toPrediction(gold, comparison) {
  return {
    ...gold,
    prediction: comparison.verdict === "independent" ? "independent" : comparison.verdict,
    predictionBasis: comparison.basis,
    witnessTypes: comparison.witnesses?.map((witness) => witness.type) || [],
    detectorEvidence: comparison.evidence || [],
    causalStatus: comparison.causalAnalysis?.status || null,
  };
}

function markdown(metrics) {
  const pct = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  return [
    `# Semantic clean benchmark v0.1 · ${version}`,
    "",
    `- Cases: ${metrics.dataset.evaluated} (${metrics.dataset.conflicts} positive / ${metrics.dataset.harmless} hard negative)`,
    `- Repositories: ${metrics.dataset.repos}`,
    `- Languages: ${metrics.dataset.languages} (Java only in this first frozen set)`,
    `- Triage precision: ${pct(metrics.triage.precision)}`,
    `- Triage recall: ${pct(metrics.triage.recall)}`,
    `- Triage F1: ${pct(metrics.triage.f1)}`,
    `- Blocker precision: ${pct(metrics.blocker.precision)}`,
    `- Blocker recall: ${pct(metrics.blocker.recall)}`,
    `- Harmless review rate: ${pct(metrics.routing.harmlessReviewRate)}`,
    `- Work reduction: ${pct(metrics.routing.workReduction)}`,
    "",
    "> This benchmark establishes an actual clean-merge baseline, but its positives are all historical Java merges. It does not establish cross-language or open-PR generalization.",
    "",
  ].join("\n");
}

function errorLedger(predictions) {
  const missed = predictions.filter((record) => record.gold === "conflict" && !["conflict", "coordination", "review"].includes(record.prediction));
  const noisy = predictions.filter((record) => record.gold === "harmless" && ["conflict", "coordination", "review"].includes(record.prediction));
  return [
    ...missed.map((record) => ({
      schemaVersion: "semantic-error-ledger-v0.1",
      id: record.id,
      errorType: "false-negative",
      expected: "triage",
      predicted: record.prediction,
      pipelineStage: "candidate-verification",
      rootCause: `missing-${record.archetype}-dependency-rule`,
      observedWitnessTypes: record.witnessTypes,
      causalStatus: record.causalStatus,
      recommendedExperiment: `Add a directional ${record.archetype} detector, then compare this slice without changing unrelated rules.`,
    })),
    ...noisy.map((record) => ({
      schemaVersion: "semantic-error-ledger-v0.1",
      id: record.id,
      errorType: "false-positive",
      expected: "independent",
      predicted: record.prediction,
      pipelineStage: "candidate-verification",
      rootCause: "composition-risk-without-compatibility-proof",
      observedWitnessTypes: record.witnessTypes,
      causalStatus: record.causalStatus,
      recommendedExperiment: "Require an actual cross-parent dependency before add-vs-add becomes review, or prove an intended additive union.",
    })),
  ];
}

async function main() {
  const root = resolve(rootArg);
  const outputDir = resolve(outputArg);
  const [scam, samChanges, samScenarios] = await Promise.all([
    readJsonl(join(root, "scam-v0.1", "candidates.jsonl")),
    readJsonl(join(root, "sam-v0.1", "changes.jsonl")),
    readJsonl(join(root, "sam-v0.1", "scenarios.jsonl")),
  ]);
  const positives = scam.filter((record) => record.sourceLabel === "reviewed-merge-induced-defect"
    && record.semanticEligibility === "candidate"
    && record.git.automaticTreeMatchesRecordedMerge
    && !POSITIVE_EXCLUSIONS.has(record.caseId));
  if (positives.length !== 20) throw new Error(`expected 20 curated positives, got ${positives.length}`);

  const negativeScenarioIds = unique(samChanges
    .filter((record) => record.sourceLabel === "no-local-interference" && record.semanticEligibility === "candidate")
    .map((record) => record.scenarioId));
  for (const id of PRODUCT_HARD_NEGATIVE_SCENARIOS.keys()) negativeScenarioIds.push(id);
  if (unique(negativeScenarioIds).length !== 20) throw new Error(`expected 20 curated hard-negative scenarios, got ${unique(negativeScenarioIds).length}`);

  const cases = [];
  for (const record of positives) {
    const repoDir = resolve(".cache", "scam-history", `${record.project.replaceAll("/", "__")}.git`);
    const prs = await Promise.all(record.git.parents.map((parent, index) => parentInput(repoDir, record.project, record.git.base, parent, index + 1)));
    const gold = goldRecord({
      id: record.caseId, project: record.project, mergeCommit: record.mergeCommit, fixingCommit: record.fixingCommit,
      git: record.git, gold: "conflict", rationale: record.sourceRationale,
      source: { corpus: "SCAM 2023 fixing-commit study", sourceLabel: record.sourceLabel },
      archetype: positiveArchetype(record.sourceRationale),
    });
    cases.push({ gold, prs });
  }
  const scenarioById = new Map(samScenarios.map((scenario) => [scenario.scenarioId, scenario]));
  for (const scenarioId of unique(negativeScenarioIds)) {
    const scenario = scenarioById.get(scenarioId);
    if (!scenario || scenario.semanticEligibility !== "candidate") throw new Error(`missing clean SAM scenario ${scenarioId}`);
    const changes = samChanges.filter((change) => change.scenarioId === scenarioId);
    const customRationale = PRODUCT_HARD_NEGATIVE_SCENARIOS.get(scenarioId);
    const rationale = customRationale || changes.filter((change) => change.sourceLabel === "no-local-interference").map((change) => change.sourceRationale).join(" ");
    const repoDir = resolve(".cache", "history", `${scenario.project.replaceAll("/", "__")}.git`);
    const prs = await Promise.all(scenario.git.parents.map((parent, index) => parentInput(repoDir, scenario.project, scenario.git.base, parent, index + 1)));
    const gold = goldRecord({
      id: scenarioId, project: scenario.project, mergeCommit: scenario.mergeCommit, git: scenario.git,
      gold: "harmless", rationale,
      source: { corpus: "SAM manually adjudicated change pairs", sourceLabel: customRationale ? "product-intended-union" : "no-local-interference" },
      archetype: negativeArchetype(rationale),
    });
    cases.push({ gold, prs });
  }

  const predictions = cases.map(({ gold, prs }) => {
    const prepared = prepareAnalysis(prs);
    const comparison = prepared.comparisons[0];
    return toPrediction(gold, comparison);
  });
  const metrics = evaluateRecords(predictions);
  const errors = errorLedger(predictions);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, "gold.jsonl"), jsonl(cases.map(({ gold }) => gold))),
    writeFile(join(outputDir, "inputs.jsonl"), jsonl(cases.map(({ gold, prs }) => ({ schemaVersion: "semantic-clean-input-v0.1", id: gold.id, prs })))),
    writeFile(join(outputDir, `predictions-${version}.jsonl`), jsonl(predictions)),
    writeFile(join(outputDir, `error-ledger-${version}.jsonl`), jsonl(errors)),
    writeFile(join(outputDir, `metrics-${version}.json`), `${JSON.stringify(metrics, null, 2)}\n`),
    writeFile(join(outputDir, `report-${version}.md`), markdown(metrics)),
  ]);
  console.log(`Semantic clean benchmark frozen: ${outputDir}`);
  console.log(`${metrics.dataset.conflicts} positive · ${metrics.dataset.harmless} hard negative · ${metrics.dataset.repos} repositories`);
  console.log(`triage precision ${metrics.triage.precision?.toFixed(3)} · recall ${metrics.triage.recall?.toFixed(3)} · F1 ${metrics.triage.f1?.toFixed(3)}`);
}

main().catch((error) => {
  console.error(`Build semantic clean benchmark: ${error.stack || error.message}`);
  process.exitCode = 1;
});
