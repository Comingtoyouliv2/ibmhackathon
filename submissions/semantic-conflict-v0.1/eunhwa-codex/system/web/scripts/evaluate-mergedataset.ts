import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { analyze, type AnalysisResult, type PullRequestInput } from "../app/lib/analyzer";

type MergeDatasetHint = {
  className: string;
  declaration: string;
};

type MergeDatasetPair = {
  id: string;
  project: string;
  mergeCommit: string;
  base: string;
  parentA: string;
  parentB: string;
  label: "conflict" | "harmless";
  linesA: number;
  linesB: number;
  hints?: MergeDatasetHint[];
  diffA: string;
  diffB: string;
};

type Stage = "textMerge" | "candidate" | "triage" | "confirmed" | "combinedTriage" | "combinedConfirmed" | "binary";

type PairMergeResult = {
  status: "clean" | "text_conflict" | "error";
  evidence: string[];
};

type EvaluationRow = {
  id: string;
  project: string;
  label: MergeDatasetPair["label"];
  predicted: Record<Stage, boolean>;
  pairMerge: PairMergeResult;
  candidates: AnalysisResult["candidates"];
  needsVerification: NonNullable<AnalysisResult["needsVerification"]>;
  conflicts: AnalysisResult["conflicts"];
  hints: MergeDatasetHint[];
};

type Confusion = {
  evaluated: number;
  positives: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  specificity: number;
  f1: number;
};

function filesFromDiff(diff: string): string[] {
  return [...new Set([...diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map((match) => match[1]))];
}

function git(repository: string, args: string[], allowConflict = false) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180_000,
  });
  if (result.status === 0 || (allowConflict && result.status === 1)) return result;
  throw new Error((result.stderr || result.stdout || `git exited ${result.status}`).trim().slice(0, 2000));
}

function verifyPairMerges(pairs: MergeDatasetPair[]): Map<string, PairMergeResult> {
  const results = new Map<string, PairMergeResult>();
  const cacheRoot = resolve(process.env.MERGEDATASET_GIT_CACHE ?? "work/mergedataset-git");
  mkdirSync(cacheRoot, { recursive: true });
  const byProject = new Map<string, MergeDatasetPair[]>();
  for (const pair of pairs) byProject.set(pair.project, [...(byProject.get(pair.project) ?? []), pair]);

  for (const [project, projectPairs] of byProject) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project)) {
      for (const pair of projectPairs) results.set(pair.id, { status: "error", evidence: [`Invalid project name: ${project}`] });
      continue;
    }
    const repository = resolve(cacheRoot, project.replace("/", "__"));
    try {
      if (!existsSync(repository)) {
        mkdirSync(repository, { recursive: true });
        git(repository, ["init", "--bare", "-q"]);
        git(repository, ["remote", "add", "origin", `https://github.com/${project}.git`]);
      }
      const shas = [...new Set(projectPairs.flatMap((pair) => [pair.base, pair.parentA, pair.parentB, pair.mergeCommit]))];
      const missing = shas.filter((sha) => {
        const check = spawnSync("git", ["-C", repository, "cat-file", "-e", `${sha}^{commit}`], { encoding: "utf8" });
        return check.status !== 0;
      });
      if (missing.length > 0) git(repository, ["fetch", "-q", "--no-tags", "--depth=1", "origin", ...missing]);

      for (const pair of projectPairs) {
        const merged = git(repository, ["merge-tree", "--write-tree", "--merge-base", pair.base, pair.parentA, pair.parentB], true);
        const output = `${merged.stdout}\n${merged.stderr}`;
        const conflictLines = output.split("\n").map((line) => line.trim()).filter((line) => line.includes("CONFLICT ("));
        if (merged.status === 1 && conflictLines.length > 0) {
          results.set(pair.id, { status: "text_conflict", evidence: conflictLines });
        } else if (merged.status === 0) {
          results.set(pair.id, { status: "clean", evidence: [`merged tree ${merged.stdout.trim().split("\n")[0]}`] });
        } else {
          results.set(pair.id, { status: "error", evidence: [output.trim().slice(0, 2000)] });
        }
      }
    } catch (error) {
      for (const pair of projectPairs) results.set(pair.id, { status: "error", evidence: [String(error)] });
    }
  }
  return results;
}

function pr(number: number, pair: MergeDatasetPair, side: "A" | "B"): PullRequestInput {
  const diff = side === "A" ? pair.diffA : pair.diffB;
  return {
    number,
    title: `${pair.id} parent ${side}`,
    headSha: side === "A" ? pair.parentA : pair.parentB,
    baseSha: pair.base,
    ciPassed: true,
    // Every record has a real merge commit. The dataset therefore supplies
    // pair-level text mergeability independently from the semantic label.
    mergeable: true,
    files: filesFromDiff(diff),
    diff,
  };
}

function ratio(value: number, total: number): number {
  return total === 0 ? 0 : value / total;
}

function confusion(rows: EvaluationRow[], stage: Stage, expectedFor: (row: EvaluationRow) => boolean): Confusion {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const row of rows) {
    const expected = expectedFor(row);
    const actual = row.predicted[stage];
    if (expected && actual) tp++;
    else if (!expected && actual) fp++;
    else if (!expected) tn++;
    else fn++;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const specificity = ratio(tn, tn + fp);
  return {
    evaluated: rows.length,
    positives: rows.filter(expectedFor).length,
    tp,
    fp,
    tn,
    fn,
    precision,
    recall,
    specificity,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function markdown(
  rows: EvaluationRow[],
  source: string,
  metrics: Record<"binaryVerdict" | "semanticCandidate" | "semanticTriage" | "semanticConfirmed" | "combinedTriage" | "combinedConfirmed", Confusion>,
): string {
  const gitSummary = {
    clean: rows.filter((row) => row.pairMerge.status === "clean").length,
    textConflict: rows.filter((row) => row.pairMerge.status === "text_conflict").length,
    error: rows.filter((row) => row.pairMerge.status === "error").length,
  };
  const lines = [
    "# MergeDataset evaluation",
    "",
    `Source: \`${source}\``,
    `Evaluated: ${new Date().toISOString()}`,
    "",
    "The dataset label is evaluated as a semantic/behavior label. Git text conflicts are derived independently by merging `parentA` and `parentB` with the supplied `base`.",
    "Ground-truth `label` and `hints` are never passed to either detector.",
    "",
    `Git pair merge: ${gitSummary.clean} clean, ${gitSummary.textConflict} text conflicts, ${gitSummary.error} errors.`,
    `Binary result: ${rows.filter((row) => row.predicted.binary).length} conflict, ${rows.filter((row) => !row.predicted.binary).length} no conflict.`,
    "",
    "| scope | evaluated | positive | TP | FP | TN | FN | precision | recall | specificity | F1 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const scope of ["binaryVerdict"] as const) {
    const metric = metrics[scope];
    lines.push(`| ${scope} | ${metric.evaluated} | ${metric.positives} | ${metric.tp} | ${metric.fp} | ${metric.tn} | ${metric.fn} | ${percent(metric.precision)} | ${percent(metric.recall)} | ${percent(metric.specificity)} | ${percent(metric.f1)} |`);
  }
  lines.push("", "## Pair results", "", "| pair | dataset label | app verdict | reason | shared resource or ground-truth hint |", "|---|---|---|---|---|");
  for (const row of rows) {
    const resources = row.candidates.flatMap((candidate) => candidate.sharedResources);
    const evidence = resources.length > 0
      ? [...new Set(resources)].join(", ")
      : row.hints.map((hint) => `${hint.className}#${hint.declaration}`).join(", ");
    const reason = row.predicted.textMerge ? "Git text conflict" : row.predicted.triage ? "semantic conflict signal" : "no conflict evidence";
    lines.push(`| ${row.id} | ${row.label} | ${row.predicted.binary ? "conflict" : "no conflict"} | ${reason} | ${evidence.replaceAll("|", "\\|")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const source = resolve(process.argv[2] ?? "/Users/eunhwa/Downloads/mergedataset_pairs.jsonl");
  const outputPrefix = resolve(process.argv[3] ?? `artifacts/${basename(source, ".jsonl")}-evaluation`);
  const raw = await readFile(source, "utf8");
  const pairs = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as MergeDatasetPair;
    } catch (error) {
      throw new Error(`Invalid JSON on line ${index + 1}: ${String(error)}`);
    }
  });
  const pairMerges = process.env.MERGEDATASET_SKIP_GIT === "1"
    ? new Map(pairs.map((pair) => [pair.id, { status: "error", evidence: ["Git verification skipped"] } satisfies PairMergeResult]))
    : verifyPairMerges(pairs);

  const rows = pairs.map<EvaluationRow>((pair, index) => {
    const result = analyze([pr(index * 2 + 1, pair, "A"), pr(index * 2 + 2, pair, "B")]);
    const semanticCandidates = result.semanticCandidates ?? result.candidates;
    const candidate = semanticCandidates.length > 0;
    const confirmed = result.conflicts.length > 0;
    const triage = confirmed || (result.needsVerification?.length ?? 0) > 0;
    const pairMerge = pairMerges.get(pair.id) ?? { status: "error", evidence: ["Missing pair-merge result"] };
    const textMerge = pairMerge.status === "text_conflict";
    return {
      id: pair.id,
      project: pair.project,
      label: pair.label,
      predicted: {
        textMerge,
        candidate,
        triage,
        confirmed,
        combinedTriage: textMerge || triage,
        combinedConfirmed: textMerge || confirmed,
        binary: textMerge || triage,
      },
      pairMerge,
      candidates: semanticCandidates,
      needsVerification: result.needsVerification ?? [],
      conflicts: result.conflicts,
      hints: pair.hints ?? [],
    };
  });

  const gitCleanRows = rows.filter((row) => row.pairMerge.status === "clean");
  const gitClassifiedRows = rows.filter((row) => row.pairMerge.status !== "error");
  const semanticExpected = (row: EvaluationRow) => row.label === "conflict";
  const combinedExpected = (row: EvaluationRow) => row.pairMerge.status === "text_conflict" || row.label === "conflict";
  const metrics = {
    binaryVerdict: confusion(gitClassifiedRows, "binary", combinedExpected),
    semanticCandidate: confusion(gitCleanRows, "candidate", semanticExpected),
    semanticTriage: confusion(gitCleanRows, "triage", semanticExpected),
    semanticConfirmed: confusion(gitCleanRows, "confirmed", semanticExpected),
    combinedTriage: confusion(gitClassifiedRows, "combinedTriage", combinedExpected),
    combinedConfirmed: confusion(gitClassifiedRows, "combinedConfirmed", combinedExpected),
  };
  const gitSummary = {
    clean: rows.filter((row) => row.pairMerge.status === "clean").length,
    textConflict: rows.filter((row) => row.pairMerge.status === "text_conflict").length,
    error: rows.filter((row) => row.pairMerge.status === "error").length,
  };
  const report = { source, evaluatedAt: new Date().toISOString(), pairCount: rows.length, gitSummary, metrics, rows };
  await writeFile(`${outputPrefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(`${outputPrefix}.md`, markdown(rows, source, metrics));
  process.stdout.write(`${markdown(rows, source, metrics)}\n`);
}

await main();
