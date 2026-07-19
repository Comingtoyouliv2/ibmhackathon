#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareIntegratedAnalysis } from "../src/integrated.mjs";
import { DockerCombinedVerifier, loadVerificationProfiles } from "../src/docker-verifier.mjs";
import { GitMergeTreePreflight } from "../src/preflight.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (flag, fallback = null) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : fallback; };
const readJsonl = async (path) => (await readFile(path, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
const jsonl = (rows) => rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";

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
      await verifier.assertDocker();
      await preflightEngine.initialize(prepared.prs);
      await preflightEngine.prepareBaseMerges(prepared.prs);
      const prsById = new Map(prepared.prs.map((pr) => [String(pr.id), pr]));
      for (const action of repositoryActions) {
        const key = [...action.prNumbers].map(Number).sort((a, b) => a - b).join(":");
        const comparison = comparisonByNumbers.get(key);
        if (!comparison || action.prNumbers.some((number) => !byNumber.has(Number(number)))) {
          errors.push({ actionId: action.id, repository: snapshot.repository, error: "pair not present in immutable snapshot input" });
          continue;
        }
        try {
          const verification = await verifier.verifyPair(comparison, prsById);
          const pairIds = new Set(action.prNumbers.map(Number));
          results.push({
            schemaVersion: "live-verification-result-v0.1",
            actionId: action.id,
            repository: snapshot.repository,
            liveRun,
            input: { schemaVersion: "semantic-clean-input-v0.1", prs: liveInput.prs.filter((pr) => pairIds.has(Number(pr.number))) },
            finding: snapshot.findings.find((finding) => finding.logicalKey === action.logicalKey) || null,
            verification,
          });
        } catch (error) { errors.push({ actionId: action.id, repository: snapshot.repository, error: error.message }); }
      }
    } finally { await preflightEngine.cleanup?.().catch(() => {}); }
  }
  await Promise.all([
    writeFile(join(output, "results.jsonl"), jsonl(results)),
    writeFile(join(output, "errors.jsonl"), jsonl(errors)),
    writeFile(join(output, "run.json"), `${JSON.stringify({ schemaVersion: "live-verification-run-v0.1", harness, generatedAt: new Date().toISOString(), resultCount: results.length, errorCount: errors.length }, null, 2)}\n`),
  ]);
  console.log(`Verified: ${results.length}`);
  console.log(`Errors: ${errors.length}`);
  console.log(`Saved: ${output}`);
  if (errors.length) process.exitCode = 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
