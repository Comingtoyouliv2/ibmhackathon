#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

function usage() {
  console.log(`Usage:
  node eval/run-comparison-v0.2.mjs \\
    --pair-suite DIR --radar-suite DIR --output DIR \\
    [--systems current,team1] [--tracks pair,radar] \\
    [--team1-model gpt-5.4] [--team1-concurrency 4] \\
    [--pair-gold FILE --radar-gold FILE] [--score-only] [--dry-run]

Gold arguments are optional and are used only after every selected system finishes.
They are never forwarded to a system runner.`);
}

function parseArgs(argv) {
  const options = {
    systems: ["current", "team1"],
    tracks: ["pair", "radar"],
    team1Model: process.env.EVAL_MODEL || "gpt-5.4",
    team1Concurrency: 4,
    dryRun: false,
    scoreOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--score-only") options.scoreOnly = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (["--pair-suite", "--radar-suite", "--output", "--systems", "--tracks", "--team1-model", "--team1-concurrency", "--pair-gold", "--radar-gold"].includes(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--pair-suite") options.pairSuite = resolve(value);
      else if (arg === "--radar-suite") options.radarSuite = resolve(value);
      else if (arg === "--output") options.output = resolve(value);
      else if (arg === "--systems") options.systems = value.split(",").filter(Boolean);
      else if (arg === "--tracks") options.tracks = value.split(",").filter(Boolean);
      else if (arg === "--team1-model") options.team1Model = value;
      else if (arg === "--team1-concurrency") options.team1Concurrency = Number(value);
      else if (arg === "--pair-gold") options.pairGold = resolve(value);
      else options.radarGold = resolve(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function command(program, args, { dryRun = false } = {}) {
  const printable = [program, ...args].map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(" ");
  if (dryRun) {
    console.log(printable);
    return;
  }
  execFileSync(program, args, { cwd: ROOT, stdio: "inherit", env: process.env, maxBuffer: 128 * 1024 * 1024 });
}

function pct(value) {
  return value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

async function writeSummary(options) {
  const results = [];
  for (const system of options.systems) {
    const row = { system };
    if (options.tracks.includes("pair") && options.pairGold) {
      const metrics = JSON.parse(await readFile(join(options.output, system, "pair-score", "metrics.json"), "utf8"));
      row.pair = {
        triagePrecision: metrics.triage.precision,
        triageRecall: metrics.triage.recall,
        triageF1: metrics.triage.f1,
        blockerPrecision: metrics.blocker.precision,
        blockerRecall: metrics.blocker.recall,
        falseBlockerRate: metrics.blocker.falsePositiveRate,
        workReduction: metrics.routing.workReduction,
      };
    }
    if (options.tracks.includes("radar") && options.radarGold) {
      const metrics = JSON.parse(await readFile(join(options.output, system, "radar-score", "metrics.json"), "utf8"));
      row.radar = metrics.macro;
    }
    results.push(row);
  }
  const lines = [
    "# Frozen system comparison v0.2",
    "",
    `- Systems: ${options.systems.join(", ")}`,
    `- Tracks: ${options.tracks.join(", ")}`,
    "- Gold was supplied only to the post-run evaluator.",
    "",
  ];
  if (results.some((row) => row.pair)) {
    lines.push(
      "## Pair judgment",
      "",
      "| System | Triage P | Triage R | Triage F1 | Blocker P | Blocker R | False blocker | Work reduction |",
      "|---|---:|---:|---:|---:|---:|---:|---:|",
      ...results.map((row) => `| ${row.system} | ${pct(row.pair?.triagePrecision)} | ${pct(row.pair?.triageRecall)} | ${pct(row.pair?.triageF1)} | ${pct(row.pair?.blockerPrecision)} | ${pct(row.pair?.blockerRecall)} | ${pct(row.pair?.falseBlockerRate)} | ${pct(row.pair?.workReduction)} |`),
      "",
    );
  }
  if (results.some((row) => row.radar)) {
    lines.push(
      "## End-to-end radar",
      "",
      "| System | MAP@20 | R@5 | P@5 | R@10 | P@10 | R@20 | P@20 |",
      "|---|---:|---:|---:|---:|---:|---:|---:|",
      ...results.map((row) => `| ${row.system} | ${pct(row.radar?.meanAveragePrecisionAt20)} | ${pct(row.radar?.recallAt5)} | ${pct(row.radar?.precisionAt5)} | ${pct(row.radar?.recallAt10)} | ${pct(row.radar?.precisionAt10)} | ${pct(row.radar?.recallAt20)} | ${pct(row.radar?.precisionAt20)} |`),
      "",
    );
  }
  await Promise.all([
    writeFile(join(options.output, "comparison.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`),
    writeFile(join(options.output, "comparison.md"), `${lines.join("\n")}\n`),
  ]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const allowedSystems = new Set(["current", "team1"]);
  const allowedTracks = new Set(["pair", "radar"]);
  if (!options.output || options.systems.some((item) => !allowedSystems.has(item)) || options.tracks.some((item) => !allowedTracks.has(item))) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (options.tracks.includes("pair") && !options.pairSuite) throw new Error("--pair-suite is required for pair track");
  if (options.tracks.includes("radar") && !options.radarSuite) throw new Error("--radar-suite is required for radar track");
  if (!Number.isInteger(options.team1Concurrency) || options.team1Concurrency < 1) throw new Error("--team1-concurrency must be a positive integer");

  await mkdir(options.output, { recursive: true });
  const planPath = join(options.output, "run-plan.json");
  let frozenPlan = null;
  if (options.scoreOnly) {
    try {
      frozenPlan = JSON.parse(await readFile(planPath, "utf8"));
    } catch {
      throw new Error(`--score-only requires the original frozen plan: ${planPath}`);
    }
  }
  const plan = {
    schemaVersion: "frozen-comparison-plan-v0.2",
    createdAt: new Date().toISOString(),
    systems: options.systems,
    tracks: options.tracks,
    suites: {},
    frozenCode: {
      currentAnalyzer: await digest(join(ROOT, "src", "analyzer.mjs")),
      currentPairRunner: await digest(join(ROOT, "eval", "run-current-pair-qualification.mjs")),
      currentRadarRunner: await digest(join(ROOT, "eval", "run-current-radar-arena.mjs")),
      team1Adapter: await digest(join(ROOT, "eval", "run-team1-codex-v0.2.mjs")),
    },
    team1: { model: options.team1Model, concurrency: options.team1Concurrency },
  };
  if (options.pairSuite) {
    plan.suites.pair = {
      input: { path: join(options.pairSuite, "inputs.jsonl"), sha256: await digest(join(options.pairSuite, "inputs.jsonl")) },
      prompt: { path: join(options.pairSuite, "SYSTEM_PROMPT.txt"), sha256: await digest(join(options.pairSuite, "SYSTEM_PROMPT.txt")) },
      template: { path: join(options.pairSuite, "USER_PROMPT_TEMPLATE.txt"), sha256: await digest(join(options.pairSuite, "USER_PROMPT_TEMPLATE.txt")) },
      schema: { path: join(options.pairSuite, "prediction.schema.json"), sha256: await digest(join(options.pairSuite, "prediction.schema.json")) },
    };
  }
  if (options.radarSuite) {
    const episodes = join(options.radarSuite, "episodes");
    const names = (await readdir(episodes)).filter((name) => /^episode-\d+\.json$/.test(name)).sort();
    plan.suites.radar = {
      task: { path: join(options.radarSuite, "TASK_PROMPT.txt"), sha256: await digest(join(options.radarSuite, "TASK_PROMPT.txt")) },
      schema: { path: join(options.radarSuite, "prediction.schema.json"), sha256: await digest(join(options.radarSuite, "prediction.schema.json")) },
      episodes: await Promise.all(names.map(async (name) => ({ name, sha256: await digest(join(episodes, name)) }))),
    };
  }
  if (frozenPlan) {
    if (JSON.stringify(frozenPlan.systems) !== JSON.stringify(plan.systems)
      || JSON.stringify(frozenPlan.tracks) !== JSON.stringify(plan.tracks)
      || JSON.stringify(frozenPlan.suites) !== JSON.stringify(plan.suites)
      || JSON.stringify(frozenPlan.frozenCode) !== JSON.stringify(plan.frozenCode)) {
      throw new Error("frozen code, suite inputs, systems, or tracks changed before scoring");
    }
  }
  if (!options.scoreOnly) await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  if (!options.scoreOnly) {
    for (const system of options.systems) {
      if (options.tracks.includes("pair")) {
        const output = join(options.output, system, "pair");
        if (system === "current") command("node", ["eval/run-current-pair-qualification.mjs", join(options.pairSuite, "inputs.jsonl"), output], options);
        else command("node", ["eval/run-team1-codex-v0.2.mjs", "pair", "--suite", options.pairSuite, "--output", output, "--model", options.team1Model, "--concurrency", String(options.team1Concurrency)], options);
      }
      if (options.tracks.includes("radar")) {
        const output = join(options.output, system, "radar");
        if (system === "current") command("node", ["eval/run-current-radar-arena.mjs", join(options.radarSuite, "episodes"), output], options);
        else command("node", ["eval/run-team1-codex-v0.2.mjs", "radar", "--suite", options.radarSuite, "--output", output, "--model", options.team1Model, "--concurrency", String(Math.min(2, options.team1Concurrency))], options);
      }
    }
  }

  if (options.dryRun) return;
  for (const system of options.systems) {
    if (options.tracks.includes("pair") && options.pairGold) {
      command("node", ["eval/evaluate-pair-qualification.mjs", options.pairGold, join(options.output, system, "pair", "predictions.jsonl"), join(options.output, system, "pair-score")]);
    }
    if (options.tracks.includes("radar") && options.radarGold) {
      command("node", ["eval/evaluate-radar-arena.mjs", options.radarGold, join(options.output, system, "radar", "predictions.jsonl"), join(options.output, system, "radar-score")]);
    }
  }
  if (options.pairGold || options.radarGold) await writeSummary(options);
  console.log(`Comparison complete: ${options.output}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
