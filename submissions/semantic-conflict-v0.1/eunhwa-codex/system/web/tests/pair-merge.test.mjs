import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateFileOverlapCandidates } from "../app/lib/pair-merge.ts";
import { analyze } from "../app/lib/analyzer.ts";

test("file overlap creates deterministic pair-merge candidates", () => {
  const candidates = generateFileOverlapCandidates([
    { pr: 10, files: ["src/a.ts", "src/shared.ts", "src/shared.ts"] },
    { pr: 20, files: ["src/shared.ts", "package.json"] },
    { pr: 30, files: ["src/isolated.ts"] },
  ]);
  assert.deepEqual(candidates, [{
    a: 10,
    b: 20,
    sharedResources: ["file:src/shared.ts"],
    evidenceStrength: "strong",
    joinReasons: ["file_overlap:strong"],
    candidateScore: 10,
    candidateTier: "strong",
    candidateSources: ["git_path"],
  }]);
});

test("rename old and new paths both create Git candidates", () => {
  const candidates = generateFileOverlapCandidates([
    { pr: 1, files: ["src/new.ts"], fileChanges: [{ path: "src/new.ts", previousPath: "src/old.ts", operation: "renamed" }] },
    { pr: 2, files: ["src/old.ts"], fileChanges: [{ path: "src/old.ts", operation: "modified" }] },
    { pr: 3, files: ["src/new.ts"], fileChanges: [{ path: "src/new.ts", operation: "modified" }] },
  ]);
  assert.deepEqual(candidates.map((pair) => [pair.a, pair.b, pair.joinReasons]), [
    [1, 2, ["rename_path_overlap:strong"]],
    [1, 3, ["rename_path_overlap:strong"]],
  ]);
});

test("file and descendant path form a directory collision candidate", () => {
  const candidates = generateFileOverlapCandidates([
    { pr: 1, files: ["config"], fileChanges: [{ path: "config", operation: "added" }] },
    { pr: 2, files: ["config/app.yml"], fileChanges: [{ path: "config/app.yml", operation: "added" }] },
  ]);
  assert.deepEqual(candidates[0].joinReasons, ["file_directory_overlap:strong"]);
  assert.deepEqual(candidates[0].sharedResources, ["path-prefix:config↔config/app.yml"]);
});

test("multiple shared files are folded into one sorted pair", () => {
  const candidates = generateFileOverlapCandidates([
    { pr: 9, files: ["z.txt", "a.txt"] },
    { pr: 4, files: ["a.txt", "z.txt"] },
  ]);
  assert.deepEqual(candidates[0].sharedResources, ["file:a.txt", "file:z.txt"]);
  assert.deepEqual([candidates[0].a, candidates[0].b], [4, 9]);
});

test("CI-failed but individually mergeable PRs remain pair-merge candidates", () => {
  const result = analyze([
    { number: 1, title: "passed", ciPassed: true, ciStatus: "passed", mergeable: true, files: ["src/shared.ts"], diff: "+const a = 1" },
    { number: 2, title: "failed", ciPassed: false, ciStatus: "failed", mergeable: true, files: ["src/shared.ts"], diff: "+const b = 2" },
  ]);
  assert.equal(result.eligiblePrs, 2);
  assert.equal(result.pairMergePrs, 2);
  assert.deepEqual(result.cards.map((card) => [card.pr, card.ciStatus]), [[1, "passed"], [2, "failed"]]);
  assert.deepEqual(result.pairMergeCards.map((card) => [card.pr, card.ciStatus]), [[1, "passed"], [2, "failed"]]);
  assert.deepEqual(generateFileOverlapCandidates(result.pairMergeCards).map((pair) => [pair.a, pair.b]), [[1, 2]]);
});

test("synthetic merge tree isolates PR files from upstream drift", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pair-merge-files-"));
  const git = (...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Contract Radar Test");
    git("config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(directory, "base.txt"), "base\n");
    git("add", "base.txt");
    git("commit", "-q", "-m", "base");
    git("switch", "-q", "-c", "pr");
    fs.writeFileSync(path.join(directory, "feature.txt"), "feature\n");
    git("add", "feature.txt");
    git("commit", "-q", "-m", "feature");
    git("switch", "-q", "main");
    fs.writeFileSync(path.join(directory, "upstream.txt"), "upstream\n");
    git("add", "upstream.txt");
    git("commit", "-q", "-m", "upstream");
    const currentBase = git("rev-parse", "HEAD");
    const prHead = git("rev-parse", "pr");
    git("merge", "-q", "--no-ff", "pr", "-m", "synthetic merge");
    const syntheticMerge = git("rev-parse", "HEAD");

    assert.deepEqual(git("diff", "--name-only", currentBase, syntheticMerge).split("\n"), ["feature.txt"]);
    assert.deepEqual(git("diff", "--name-only", currentBase, prHead).split("\n").sort(), ["feature.txt", "upstream.txt"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
