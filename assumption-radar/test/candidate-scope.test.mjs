import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unauthorizedCandidateChanges, workspaceChanges } from "../eval/candidate-scope.mjs";

async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

test("candidate scope scans the whole workspace and rejects package, benchmark, and symlink edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "assumption-radar-scope-"));
  const original = join(root, "original");
  const candidate = join(root, "candidate");
  try {
    for (const workspace of [original, candidate]) await mkdir(workspace, { recursive: true });
    await Promise.all([
      put(original, "src/analyzer.mjs", "before"),
      put(candidate, "src/analyzer.mjs", "after"),
      put(original, "src/linked.mjs", "safe file"),
      put(candidate, "src/link-target.mjs", "target"),
      put(original, "package.json", "{\"version\":1}"),
      put(candidate, "package.json", "{\"version\":2}"),
      put(original, "benchmarks/frozen/gold.jsonl", "old gold"),
      put(candidate, "benchmarks/frozen/gold.jsonl", "changed gold"),
      put(original, ".cache/result.json", "old cache"),
      put(candidate, ".cache/result.json", "new cache"),
      put(original, "reports/report.md", "old report"),
      put(candidate, "reports/report.md", "new report"),
      put(candidate, "test/new.test.mjs", "test('safe', () => {})"),
    ]);
    await symlink("link-target.mjs", join(candidate, "src/linked.mjs"));

    const changed = await workspaceChanges(original, candidate);
    assert.deepEqual(changed.map((item) => item.path), [
      "benchmarks/frozen/gold.jsonl",
      "package.json",
      "src/analyzer.mjs",
      "src/link-target.mjs",
      "src/linked.mjs",
      "test/new.test.mjs",
    ]);
    assert.equal(changed.some((item) => item.path.startsWith(".cache/") || item.path.startsWith("reports/")), false);

    const unauthorized = unauthorizedCandidateChanges(changed, new Set(["src/analyzer.mjs", "src/link-target.mjs", "src/linked.mjs"]));
    assert.deepEqual(unauthorized.map((item) => item.path), [
      "benchmarks/frozen/gold.jsonl",
      "package.json",
      "src/linked.mjs",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
