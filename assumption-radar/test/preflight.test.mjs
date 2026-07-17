import test from "node:test";
import assert from "node:assert/strict";
import { finishAnalysis } from "../src/analyzer.mjs";
import { prepareAnalysisPipeline } from "../src/pipeline.mjs";
import { GitMergeTreePreflight, parseMergeTreeResult } from "../src/preflight.mjs";

const file = (filename, replacement) => ({
  filename,
  status: "modified",
  patch: `@@ -10,1 +10,1 @@ def transform():\n-return base_value\n+return ${replacement}`,
});

test("merge-tree output distinguishes clean and textual conflicts", () => {
  assert.equal(parseMergeTreeResult({ code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" }).status, "clean");
  const conflict = parseMergeTreeResult({
    code: 1,
    stdout: `${"b".repeat(40)}\nmodel.py\n\nCONFLICT (content): Merge conflict in model.py\n`,
    stderr: "",
  });
  assert.equal(conflict.status, "textual-conflict");
  assert.deepEqual(conflict.conflictPaths, ["model.py"]);
});

test("pairwise merge-tree pins current base when comparing virtual PR merges", async () => {
  const calls = [];
  const commits = ["c".repeat(40), "d".repeat(40)];
  const runner = async (program, args) => {
    calls.push([program, args]);
    if (args.includes("commit-tree")) return { code: 0, stdout: `${commits.shift()}\n`, stderr: "" };
    return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
  };
  const engine = new GitMergeTreePreflight("acme/repo", { cacheDir: "/tmp/assumption-radar-test", runner });
  const prs = [
    { id: "1", number: 1, base: "main" },
    { id: "2", number: 2, base: "main" },
  ];
  const prepared = await engine.prepareBaseMerges(prs);
  assert.deepEqual(prepared.map((item) => item.status), ["clean", "clean"]);
  const result = await engine.inspectPair({ key: "1:2", prIds: ["1", "2"] }, new Map(prs.map((pr) => [pr.id, pr])));
  assert.equal(result.status, "clean");
  const pairMergeArgs = calls.at(-1)[1];
  assert.deepEqual(pairMergeArgs.slice(-2), ["c".repeat(40), "d".repeat(40)]);
  assert.ok(pairMergeArgs.includes(`--merge-base=${engine.baseRef("main")}`));
  assert.ok(!pairMergeArgs.includes(engine.ref(1)) && !pairMergeArgs.includes(engine.ref(2)));
});

test("a PR that conflicts with current base is not multiplied into pair conflicts", async () => {
  let mergeCount = 0;
  const runner = async (program, args) => {
    if (args.includes("commit-tree")) return { code: 0, stdout: `${"d".repeat(40)}\n`, stderr: "" };
    mergeCount += 1;
    if (mergeCount === 1) return { code: 1, stdout: `${"a".repeat(40)}\ncore.go\n\nCONFLICT (content): Merge conflict in core.go\n`, stderr: "" };
    return { code: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" };
  };
  const engine = new GitMergeTreePreflight("acme/repo", { cacheDir: "/tmp/assumption-radar-test", runner });
  const prs = [
    { id: "1", number: 1, base: "main" },
    { id: "2", number: 2, base: "main" },
  ];
  await engine.prepareBaseMerges(prs);
  const result = await engine.inspectPair({ key: "1:2", prIds: ["1", "2"] }, new Map(prs.map((pr) => [pr.id, pr])));
  assert.equal(result.status, "base-conflict");
  assert.deepEqual(result.baseConflictPrNumbers, [1]);
  assert.deepEqual(result.conflictPaths, ["core.go"]);
  assert.equal(mergeCount, 2);
});

test("pipeline collapses stacked PRs and routes mechanical conflicts to coordination", async () => {
  const prs = [
    { id: "1", number: 1, title: "base refactor", updatedAt: "2026-01-01T00:00:00Z", files: [file("model.py", "refactor_value")] },
    { id: "2", number: 2, title: "stack descendant", updatedAt: "2026-01-02T00:00:00Z", files: [file("model.py", "stack_value")] },
    { id: "3", number: 3, title: "parallel fix", updatedAt: "2026-01-03T00:00:00Z", files: [file("model.py", "fixed_value")] },
  ];
  const fakeEngine = {
    async initialize(items) { return { repoDir: "/tmp/fake.git", fetchedPrs: items.length }; },
    async findStacks() { return [{ ancestorId: "1", ancestorNumber: 1, descendantId: "2", descendantNumber: 2, identicalHeads: false }]; },
    async inspectPairs(comparisons) {
      return comparisons.map((comparison) => ({ key: comparison.key, status: "textual-conflict", conflictPaths: ["model.py"], messages: ["CONFLICT"], treeOid: null }));
    },
  };
  const pipeline = await prepareAnalysisPipeline(prs, {
    repository: "acme/repo",
    useMergePreflight: true,
    preflightEngine: fakeEngine,
  });
  assert.deepEqual(pipeline.prepared.prs.map((pr) => pr.number), [2, 3]);
  assert.deepEqual(pipeline.preflight.suppressedPrNumbers, [1]);
  assert.equal(pipeline.preflight.textualConflictPairs, 1);
  const result = finishAnalysis(pipeline.prepared);
  assert.equal(result.summary.coordinationCount, 1);
  assert.equal(result.summary.reviewCount, 0);
  assert.equal(result.findings[0].semanticBenchmarkEligibility, "excluded");
  assert.equal(result.findings[0].basis, "merge-tree-textual-conflict");
  assert.equal(result.findings[0].coordinationSubtype, null);
  assert.equal(result.findings[0].requiredAction, "resolve-textual-conflict");
});
