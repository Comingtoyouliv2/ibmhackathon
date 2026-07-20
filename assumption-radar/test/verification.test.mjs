import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCombinedRuns } from "../src/combined-verifier.mjs";
import { DockerCombinedVerifier, resolveVerificationProfile } from "../src/docker-verifier.mjs";
import {
  applyVerificationResults,
  selectVerificationCandidates,
  verificationCaseRecord,
} from "../src/verification.mjs";

const run = (status, output = "") => ({ status, output, command: "test", exitCode: status === "passed" ? 0 : 1, durationMs: 1, failureSignatures: [] });

test("Base and independent PR failures are excluded from semantic conflict classification", () => {
  const result = classifyCombinedRuns({
    base: run("failed"),
    a: run("passed"),
    b: run("passed"),
    combined: run("passed"),
  });
  assert.equal(result.verdict, "excluded");
  assert.equal(result.reasonCode, "baseline-failure");

  const aFailure = classifyCombinedRuns({ base: run("passed"), a: run("failed"), b: run("passed"), combined: run("failed") });
  assert.equal(aFailure.verdict, "excluded");
  assert.equal(aFailure.reasonCode, "single-pr-regression-a");

  const bFailure = classifyCombinedRuns({ base: run("passed"), a: run("passed"), b: run("failed"), combined: run("failed") });
  assert.equal(bFailure.verdict, "excluded");
  assert.equal(bFailure.reasonCode, "single-pr-regression-b");

  const bothFail = classifyCombinedRuns({ base: run("passed"), a: run("failed"), b: run("failed"), combined: run("failed") });
  assert.equal(bothFail.verdict, "excluded");
  assert.equal(bothFail.reasonCode, "independent-pr-regressions");
});

test("verification candidates are bounded findings with a clean semantic lane", () => {
  const comparison = { key: "1:2", prIds: ["1", "2"], verdict: "review" };
  const prepared = { comparisons: [comparison, { key: "1:3", prIds: ["1", "3"], verdict: "review", mechanicalMerge: "conflict" }] };
  const analysis = { findings: [comparison, prepared.comparisons[1]] };
  assert.deepEqual(selectVerificationCandidates(prepared, analysis, { limit: 1 }).map((item) => item.key), ["1:2"]);
});

test("executable compatibility annotates a review without removing it", () => {
  const finding = { id: "f1", key: "1:2", prIds: ["1", "2"], verdict: "review", consequence: "possible failure" };
  const verification = {
    key: "1:2", prIds: ["1", "2"], verifiedAt: "2026-07-17T00:00:00Z",
    classification: { verdict: "compatible", rationale: "all pass", evidence: ["A+B: passed"] },
    runs: [],
  };
  const result = applyVerificationResults({
    findings: [finding],
    summary: { conflictCount: 0, coordinationCount: 0, reviewCount: 1 },
  }, [verification]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].verdict, "review");
  assert.equal(result.findings[0].executionStatus, "no-observed-regression");
  assert.equal(result.compatibleVerifications.length, 1);
  assert.equal(result.summary.verifiedCompatibleCount, 1);
});

test("executable compatibility never downgrades an existing conflict", () => {
  const finding = {
    id: "f1", key: "1:2", prIds: ["1", "2"], verdict: "conflict",
    basis: "deterministic-witness", source: "framework", title: "signature conflict",
  };
  const verification = {
    key: "1:2", prIds: ["1", "2"], verifiedAt: "2026-07-17T00:00:00Z",
    classification: { verdict: "compatible", rationale: "all pass", evidence: ["A+B: passed"] },
    runs: [],
  };
  const result = applyVerificationResults({
    findings: [finding],
    summary: { conflictCount: 1, coordinationCount: 0, reviewCount: 0 },
  }, [verification]);
  assert.equal(result.findings[0].verdict, "conflict");
  assert.equal(result.findings[0].basis, "deterministic-witness");
  assert.equal(result.findings[0].source, "framework");
  assert.equal(result.findings[0].title, "signature conflict");
  assert.equal(result.findings[0].executionStatus, "no-observed-regression");
  assert.equal(result.summary.conflictCount, 1);
});

test("a repeated combined-only failure promotes review to conflict", () => {
  const finding = { id: "f1", key: "1:2", prIds: ["1", "2"], verdict: "review" };
  const verification = {
    key: "1:2", prIds: ["1", "2"], verifiedAt: "2026-07-17T00:00:00Z",
    classification: { verdict: "conflict", rationale: "A+B repeatedly fails", evidence: ["error x"] },
    runs: [],
  };
  const result = applyVerificationResults({
    findings: [finding],
    summary: { conflictCount: 0, coordinationCount: 0, reviewCount: 1 },
  }, [verification]);
  assert.equal(result.findings[0].verdict, "conflict");
  assert.equal(result.findings[0].relationship, "confirmed-conflict");
  assert.equal(result.findings[0].executionStatus, "confirmed-conflict");
  assert.equal(result.summary.confirmedConflictCount, 1);
});

test("an independent PR failure removes the pair from semantic findings", () => {
  const finding = { id: "f1", key: "1:2", prIds: ["1", "2"], verdict: "conflict" };
  const verification = {
    key: "1:2", prIds: ["1", "2"], verifiedAt: "2026-07-17T00:00:00Z",
    classification: { verdict: "excluded", reasonCode: "single-pr-regression-a", rationale: "A fails alone", evidence: ["A: failed"] },
    runs: [],
  };
  const result = applyVerificationResults({ findings: [finding], summary: { conflictCount: 1, coordinationCount: 0, reviewCount: 0 } }, [verification]);
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary.conflictCount, 0);
  assert.equal(result.summary.excludedVerificationCount, 1);
  assert.equal(result.summary.singlePrRegressionCount, 1);
});

test("auto profile resolves Node and repository configuration wins", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "radar-profile-"));
  try {
    await writeFile(join(workspace, "package-lock.json"), "{}");
    assert.equal((await resolveVerificationProfile(workspace, "acme/repo")).profile, "node-npm");
    const custom = await resolveVerificationProfile(workspace, "acme/repo", { repositories: { "acme/repo": {
      profile: "custom", image: "custom:test", installCommand: "prepare", testCommand: "verify", timeoutSeconds: 10,
    } } });
    assert.equal(custom.profile, "custom");
    assert.equal(custom.source, "repository-config");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Docker verifier orchestrates Base/A/B/A+B and confirms a repeated combined-only failure", async () => {
  const engine = {
    repoDir: "/fake/repo.git",
    virtualHeads: new Map([[10, "virtual-a"], [20, "virtual-b"]]),
    ref: (number) => `refs/pr-${number}`,
    baseRef: () => "refs/base/main",
    initialize: async () => ({}),
    prepareBaseMerges: async () => [],
    inspectPair: async () => ({ status: "clean", treeOid: "tree" }),
  };
  const runner = async (program, args) => {
    if (program === "git" && args.includes("commit-tree")) return { code: 0, stdout: "combined-commit\n", stderr: "", durationMs: 1 };
    if (program === "git" && args.includes("rev-parse")) return { code: 0, stdout: "base-sha\n", stderr: "", durationMs: 1 };
    if (program === "docker" && args[0] === "info") return { code: 0, stdout: "27.0\n", stderr: "", durationMs: 1 };
    if (program === "docker" && args[0] === "run") {
      const name = args[args.indexOf("--name") + 1];
      const combinedFailure = name.includes("combined-test") || name.includes("combined-confirmation");
      return { code: combinedFailure ? 1 : 0, stdout: combinedFailure ? "Error: combined pair crash" : "ok", stderr: "", durationMs: 1 };
    }
    return { code: 0, stdout: "ok\n", stderr: "", durationMs: 1 };
  };
  const verifier = new DockerCombinedVerifier("acme/repo", {
    preflightEngine: engine,
    runner,
    profiles: { repositories: { "acme/repo": {
      profile: "fake", image: "fake:image", installCommand: "install", testCommand: "test", timeoutSeconds: 10,
    } } },
  });
  const comparison = { key: "1:2", prIds: ["1", "2"] };
  const prepared = { prs: [
    { id: "1", number: 10, base: "main", headSha: "head-a" },
    { id: "2", number: 20, base: "main", headSha: "head-b" },
  ] };
  const result = await verifier.verify(prepared, [comparison]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.verifications[0].classification.verdict, "conflict");
  assert.deepEqual(result.verifications[0].runs.map((item) => item.label), ["base", "a", "b", "combined", "combined_confirmation"]);
});

test("Docker verifier skips A+B when an independent PR fails", async () => {
  const engine = {
    repoDir: "/fake/repo.git",
    virtualHeads: new Map([[10, "virtual-a"], [20, "virtual-b"]]),
    ref: (number) => `refs/pr-${number}`,
    baseRef: () => "refs/base/main",
    initialize: async () => ({}),
    prepareBaseMerges: async () => [],
    inspectPair: async () => ({ status: "clean", treeOid: "tree" }),
  };
  const containers = [];
  const runner = async (program, args) => {
    if (program === "git" && args.includes("commit-tree")) return { code: 0, stdout: "combined-commit\n", stderr: "", durationMs: 1 };
    if (program === "git" && args.includes("rev-parse")) return { code: 0, stdout: "base-sha\n", stderr: "", durationMs: 1 };
    if (program === "docker" && args[0] === "info") return { code: 0, stdout: "27.0\n", stderr: "", durationMs: 1 };
    if (program === "docker" && args[0] === "run") {
      const name = args[args.indexOf("--name") + 1];
      containers.push(name);
      const aFailed = name.includes("-a-test");
      return { code: aFailed ? 1 : 0, stdout: aFailed ? "Error: A fails alone" : "ok", stderr: "", durationMs: 1 };
    }
    return { code: 0, stdout: "ok\n", stderr: "", durationMs: 1 };
  };
  const verifier = new DockerCombinedVerifier("acme/repo", {
    preflightEngine: engine,
    runner,
    profiles: { repositories: { "acme/repo": {
      profile: "fake", image: "fake:image", installCommand: "install", testCommand: "test", timeoutSeconds: 10,
    } } },
  });
  const result = await verifier.verify({ prs: [
    { id: "1", number: 10, base: "main", headSha: "head-a" },
    { id: "2", number: 20, base: "main", headSha: "head-b" },
  ] }, [{ key: "1:2", prIds: ["1", "2"] }]);
  assert.equal(result.verifications[0].classification.reasonCode, "single-pr-regression-a");
  assert.deepEqual(result.verifications[0].runs.map((item) => item.label), ["base", "a", "b"]);
  assert.equal(containers.some((name) => name.includes("-combined-")), false);
});

test("Docker verifier reuses Base and single-PR runs across pairs by commit SHA", async () => {
  const engine = {
    repoDir: "/fake/repo.git",
    virtualHeads: new Map([[10, "virtual-a"], [20, "virtual-b"], [30, "virtual-c"]]),
    ref: (number) => `refs/pr-${number}`,
    baseRef: () => "refs/base/main",
    initialize: async () => ({}),
    prepareBaseMerges: async () => [],
    inspectPair: async (item) => ({ status: "clean", treeOid: `tree-${item.key}` }),
  };
  const containers = [];
  const runner = async (program, args) => {
    if (program === "git" && args.includes("commit-tree")) return { code: 0, stdout: "combined-commit\n", stderr: "", durationMs: 1 };
    if (program === "git" && args.includes("rev-parse")) return { code: 0, stdout: "base-sha\n", stderr: "", durationMs: 1 };
    if (program === "docker" && args[0] === "info") return { code: 0, stdout: "27.0\n", stderr: "", durationMs: 1 };
    if (program === "docker" && args[0] === "run") containers.push(args[args.indexOf("--name") + 1]);
    return { code: 0, stdout: "ok\n", stderr: "", durationMs: 1 };
  };
  const verifier = new DockerCombinedVerifier("acme/repo", {
    preflightEngine: engine,
    runner,
    profiles: { repositories: { "acme/repo": {
      profile: "fake", image: "fake:image", installCommand: "install", testCommand: "test", timeoutSeconds: 10,
    } } },
  });
  const prs = [
    { id: "1", number: 10, base: "main", headSha: "head-a" },
    { id: "2", number: 20, base: "main", headSha: "head-b" },
    { id: "3", number: 30, base: "main", headSha: "head-c" },
  ];
  const result = await verifier.verify({ prs }, [{ key: "1:2", prIds: ["1", "2"] }, { key: "1:3", prIds: ["1", "3"] }]);
  assert.equal(result.verifications.length, 2);
  assert.equal(containers.filter((name) => name.includes("-base-test")).length, 1);
  assert.equal(containers.filter((name) => name.includes("-a-test")).length, 1);
  assert.equal(result.verifications[1].runs.find((run) => run.label === "base").cached, true);
  assert.equal(result.verifications[1].runs.find((run) => run.label === "a").cached, true);
});

test("JSONL case record keeps immutable SHAs, evidence IDs, and four-state outcomes", () => {
  const verification = {
    prIds: ["1", "2"], prNumbers: [10, 20], baseSha: "base", headShaA: "a", headShaB: "b",
    verifiedAt: "2026-07-17T00:00:00Z", profile: "node-npm",
    classification: { verdict: "conflict", rationale: "A+B fails", evidence: ["error x"] },
    runs: [
      { label: "base", ...run("passed") }, { label: "a", ...run("passed") }, { label: "b", ...run("passed") },
      { label: "combined", ...run("failed"), failureSignatures: ["error x"] },
      { label: "combined_confirmation", ...run("failed"), failureSignatures: ["error x"] },
    ],
  };
  const record = verificationCaseRecord({
    repository: "acme/repo",
    verification,
    finding: {
      category: "lifecycle", assumptionA: "ready before read", assumptionB: "init may be async", consequence: "read before ready",
      evidenceObjects: [{ side: "A", file: "a.js", quote: "read()" }, { side: "B", file: "b.js", quote: "initLater()" }],
    },
    metadata: { analyzerVersion: "1.0.0" },
  });
  assert.equal(record.relationship, "confirmed-conflict");
  assert.deepEqual(record.evidence.map((item) => item.id), ["A1", "B1"]);
  assert.equal(record.verification.runs.combined.status, "failed");
  assert.deepEqual([record.baseSha, record.prA.headSha, record.prB.headSha], ["base", "a", "b"]);
});

test("JSONL records independent failures as excluded rather than semantic conflict", () => {
  const verification = {
    prIds: ["1", "2"], prNumbers: [10, 20], baseSha: "base", headShaA: "a", headShaB: "b",
    verifiedAt: "2026-07-17T00:00:00Z", profile: "node-npm",
    classification: { verdict: "excluded", reasonCode: "single-pr-regression-b", rationale: "B fails alone", evidence: ["B: failed"] },
    runs: [{ label: "base", ...run("passed") }, { label: "a", ...run("passed") }, { label: "b", ...run("failed") }],
  };
  const record = verificationCaseRecord({ repository: "acme/repo", verification, finding: {} });
  assert.equal(record.relationship, "excluded");
  assert.equal(record.semanticBenchmarkEligibility, "excluded");
  assert.equal(record.exclusionReason, "single-pr-regression-b");
  assert.equal(record.impact.type, "single-pr-regression-b");
});
