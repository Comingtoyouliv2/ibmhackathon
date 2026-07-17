import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);

test("team1 adapter validates public pair and radar suites without model calls", () => {
  const pair = execFileSync("node", [
    "eval/run-team1-codex-v0.2.mjs", "pair",
    "--suite", "handoff/semantic-conflict-pair-judgment-v0.1",
    "--output", join(tmpdir(), "team1-pair-dry"),
    "--dry-run",
  ], { cwd: root, encoding: "utf8" });
  const radar = execFileSync("node", [
    "eval/run-team1-codex-v0.2.mjs", "radar",
    "--suite", "handoff/semantic-conflict-end-to-end-v0.1",
    "--output", join(tmpdir(), "team1-radar-dry"),
    "--dry-run",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(JSON.parse(pair).cases, 40);
  assert.equal(JSON.parse(radar).episodes, 2);
});

test("comparison dry-run freezes inputs and code without exposing gold to runners", async () => {
  const output = await mkdtemp(join(tmpdir(), "radar-comparison-plan-"));
  const stdout = execFileSync("node", [
    "eval/run-comparison-v0.2.mjs",
    "--pair-suite", "handoff/semantic-conflict-pair-judgment-v0.1",
    "--radar-suite", "handoff/semantic-conflict-end-to-end-v0.1",
    "--output", output,
    "--dry-run",
  ], { cwd: root, encoding: "utf8" });
  const plan = JSON.parse(await readFile(join(output, "run-plan.json"), "utf8"));
  assert.deepEqual(plan.systems, ["current", "team1"]);
  assert.match(plan.suites.pair.input.sha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.suites.radar.episodes.length, 2);
  assert.match(plan.frozenCode.team1Adapter, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(stdout, /gold\.jsonl/);
});
