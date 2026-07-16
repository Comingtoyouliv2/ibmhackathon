import assert from "node:assert/strict";
import test from "node:test";
import { analyze, extractIntentCard, generateBroadSemanticCandidates, generateCandidates } from "../app/lib/analyzer.ts";
import { demoPullRequests } from "../app/lib/demo.ts";

test("acceptance positive: signature change and old call form a semantic conflict", () => {
  const result = analyze(demoPullRequests);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual([result.conflicts[0].a, result.conflicts[0].b], [101, 102]);
  assert.deepEqual(result.conflicts[0].sharedResources, ["api:src/user/format#formatUser"]);
  assert.equal(result.conflicts[0].evidenceLevel, "static_proof");
  assert.match(result.conflicts[0].rationale, /1\.\.1에서 2\.\.2/);
  assert.equal(result.conflicts[0].evidence.length, 2);
  assert.deepEqual(result.needsVerification, []);
});

test("acceptance negative: unrelated PR is not joined or reported", () => {
  const result = analyze(demoPullRequests);
  assert.equal(result.candidates.some((pair) => pair.a === 101 && pair.b === 103), false);
  assert.equal(result.candidates.some((pair) => pair.a === 102 && pair.b === 103), false);
  assert.equal(result.conflicts.some((pair) => pair.a === 103 || pair.b === 103), false);
});

test("Step 0 keeps CI-failed semantic candidates but excludes text-conflicting PRs", () => {
  const result = analyze([
    { ...demoPullRequests[0], number: 201, ciPassed: false },
    { ...demoPullRequests[1], number: 202, mergeable: false },
  ]);
  assert.equal(result.eligiblePrs, 1);
  assert.deepEqual(result.cards.map((card) => [card.pr, card.ciStatus]), [[201, "failed"]]);
  assert.deepEqual(result.excluded.map((entry) => entry.reason), ["Git merge conflict"]);
});

test("a semantic conflict with an unverified CI baseline is not auto-confirmed", () => {
  const result = analyze([
    { ...demoPullRequests[0], number: 211, ciPassed: false, ciStatus: "failed" },
    { ...demoPullRequests[1], number: 212, ciPassed: true, ciStatus: "passed" },
  ]);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.needsVerification.length, 1);
  assert.equal(result.needsVerification[0].reasonCode, "ci_baseline_unverified");
  assert.match(result.needsVerification[0].rationale, /A와 B가 각각 통과/);
});

test("candidate generation joins qualified resources and records evidence strength", () => {
  const cards = demoPullRequests.map(extractIntentCard);
  assert.deepEqual(cards[0].touchedResources, ["api:src/user/format#formatUser", "surface:src/user/format#formatUser"]);
  assert.deepEqual(cards[1].touchedResources, ["api:src/user/format#formatUser", "surface:src/profile/greeting#greeting"]);
  assert.deepEqual(cards[2].touchedResources, ["api-unresolved:src/health/cache#get", "surface:src/health/cache#healthTtl"]);
  assert.deepEqual(generateCandidates(cards), [{
    a: 101,
    b: 102,
    sharedResources: ["api:src/user/format#formatUser"],
    evidenceStrength: "strong",
    joinReasons: ["api_arity:strong"],
  }]);
});

test("language-neutral hunk scopes stay candidates without a state interaction", () => {
  const result = analyze([
    {
      number: 401, title: "change retry behavior", ciPassed: true, mergeable: true, files: ["src/Worker.java"],
      diff: "diff --git a/src/Worker.java b/src/Worker.java\n@@ -10,5 +10,5 @@ public Result execute(Request request) {\n- return retry(request);\n+ return retryWithBackoff(request);",
    },
    {
      number: 402, title: "change execute ownership", ciPassed: true, mergeable: true, files: ["src/Worker.java"],
      diff: "diff --git a/src/Worker.java b/src/Worker.java\n@@ -12,5 +12,5 @@ public Result execute(Request request) {\n- owner.close();\n+ owner.release();",
    },
  ]);
  assert.deepEqual(result.candidates[0].sharedResources, ["surface:src/Worker#execute"]);
  assert.deepEqual(result.needsVerification, []);
});

test("same-state writes are promoted from candidate to semantic triage", () => {
  const result = analyze([
    {
      number: 405, title: "change query prefix", ciPassed: true, mergeable: true, files: ["src/Request.java"],
      diff: "diff --git a/src/Request.java b/src/Request.java\n@@ -80,7 +80,7 @@ public Request build() {\n- url = base;\n+ url = base + '?';",
    },
    {
      number: 406, title: "append query value", ciPassed: true, mergeable: true, files: ["src/Request.java"],
      diff: "diff --git a/src/Request.java b/src/Request.java\n@@ -92,7 +92,7 @@ public Request build() {\n- url = path;\n+ url = path + query;",
    },
  ]);
  assert.equal(result.semanticCandidates.length, 1);
  assert.equal(result.needsVerification.length, 1);
  assert.match(result.needsVerification[0].rationale, /같은 상태 쓰기: url/);
});

test("independent object fields do not become semantic triage false positives", () => {
  const result = analyze([
    {
      number: 407, title: "set transports", ciPassed: true, mergeable: true, files: ["src/Client.java"],
      diff: "diff --git a/src/Client.java b/src/Client.java\n@@ -30,7 +30,7 @@ Client copy() {\n- result.setTransports(DEFAULTS);\n+ result.setTransports(custom);",
    },
    {
      number: 408, title: "set hostname verifier", ciPassed: true, mergeable: true, files: ["src/Client.java"],
      diff: "diff --git a/src/Client.java b/src/Client.java\n@@ -38,7 +38,7 @@ Client copy() {\n- result.setHostnameVerifier(system);\n+ result.setHostnameVerifier(strict);",
    },
  ]);
  assert.equal(result.semanticCandidates.length, 1);
  assert.deepEqual(result.needsVerification, []);
});

test("concurrent literal collection growth is promoted to semantic triage", () => {
  const result = analyze([
    {
      number: 409, title: "add return keyword", ciPassed: true, mergeable: true, files: ["src/Target.java"],
      diff: "diff --git a/src/Target.java b/src/Target.java\n@@ -10,4 +10,5 @@ public class Target {\n+ \"return\",",
    },
    {
      number: 410, title: "add delete keyword", ciPassed: true, mergeable: true, files: ["src/Target.java"],
      diff: "diff --git a/src/Target.java b/src/Target.java\n@@ -12,4 +12,5 @@ public class Target {\n+ \"del\",",
    },
  ]);
  assert.equal(result.needsVerification.length, 1);
  assert.match(result.needsVerification[0].rationale, /리터럴 컬렉션의 크기/);
});

test("different structural scopes in the same file are not semantic candidates", () => {
  const result = analyze([
    {
      number: 411, title: "change start", ciPassed: true, mergeable: true, files: ["src/Worker.java"],
      diff: "diff --git a/src/Worker.java b/src/Worker.java\n@@ -10,5 +10,5 @@ public void start() {\n- state = OLD;\n+ state = READY;",
    },
    {
      number: 412, title: "change stop", ciPassed: true, mergeable: true, files: ["src/Worker.java"],
      diff: "diff --git a/src/Worker.java b/src/Worker.java\n@@ -30,5 +30,5 @@ public void stop() {\n- close();\n+ shutdown();",
    },
  ]);
  assert.deepEqual(result.candidates, []);
});

test("broad semantic index preserves cross-file subtree interactions for LLM review", () => {
  const result = analyze([
    {
      number: 421, title: "change session lease creation", ciPassed: true, mergeable: true, files: ["src/auth/session/create.java"],
      diff: "diff --git a/src/auth/session/create.java b/src/auth/session/create.java\n@@ -10,5 +10,5 @@ public Lease create() {\n- return createLease();\n+ return sessionLease.acquire();",
    },
    {
      number: 422, title: "change session lease cleanup", ciPassed: true, mergeable: true, files: ["src/auth/session/cleanup.java"],
      diff: "diff --git a/src/auth/session/cleanup.java b/src/auth/session/cleanup.java\n@@ -10,5 +10,5 @@ public void cleanup() {\n- closeLease();\n+ sessionLease.release();",
    },
  ]);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.semanticCandidates.length, 1);
  assert.deepEqual(result.semanticCandidates[0].joinReasons, ["bounded_subtree_identifier"]);
  assert.equal(result.semanticCandidates[0].candidateSources.includes("lexical"), true);
});

test("lexical fallback is degree-bounded instead of recreating all pairs", () => {
  const cards = Array.from({ length: 30 }, (_, index) => ({
    pr: index + 1,
    title: `change ${index + 1}`,
    files: [`src/runtime/part-${index + 1}.ts`],
    touchedResources: [],
    assumptions: [],
    facts: [{
      resource: `surface:src/runtime/part-${index + 1}#work${index + 1}`,
      family: "semantic_surface",
      kind: "surface_change",
      symbol: `work${index + 1}`,
      arity: 0,
      file: `src/runtime/part-${index + 1}.ts`,
      evidence: Array.from({ length: 5 }, (_, offset) => `sharedSignal${(index + offset) % 30}`).join(" "),
    }],
  }));
  const candidates = generateBroadSemanticCandidates(cards, []);
  const degree = new Map();
  for (const pair of candidates) {
    degree.set(pair.a, (degree.get(pair.a) ?? 0) + 1);
    degree.set(pair.b, (degree.get(pair.b) ?? 0) + 1);
  }
  assert.ok(candidates.length > 0);
  assert.ok(Math.max(...degree.values()) <= 8);
  assert.ok(candidates.length < (cards.length * (cards.length - 1)) / 2);
});

test("same function name imported from different modules is not joined", () => {
  const result = analyze([
    {
      number: 301, title: "change format A", ciPassed: true, mergeable: true, files: ["src/a/format.ts"],
      diff: "-export function format(value: string) {\n+export function format(value: string, locale: string) {",
    },
    {
      number: 302, title: "use format B", ciPassed: true, mergeable: true, files: ["src/view.ts"],
      diff: "+import { format } from \"./b/format\"\n+export const view = (value: string) => format(value)",
    },
  ]);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.conflicts, []);
});

test("unresolved same-name calls survive as weak candidates but are not confirmed", () => {
  const result = analyze([
    {
      number: 311, title: "change format", ciPassed: true, mergeable: true, files: ["src/a/format.ts"],
      diff: "-export function format(value: string) {\n+export function format(value: string, locale: string) {",
    },
    {
      number: 312, title: "call unknown format", ciPassed: true, mergeable: true, files: ["src/view.ts"],
      diff: "+export const view = (value: string) => format(value)",
    },
  ]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].evidenceStrength, "weak");
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.needsVerification.length, 1);
  assert.equal(result.needsVerification[0].reasonCode, "weak_symbol_identity");
});

test("adding an optional parameter does not conflict with the old call", () => {
  const result = analyze([
    {
      number: 321, title: "optional options", ciPassed: true, mergeable: true, files: ["src/save.ts"],
      diff: "-export function save(value: string) {\n+export function save(value: string, options?: object) {",
    },
    {
      number: 322, title: "old call", ciPassed: true, mergeable: true, files: ["src/use.ts"],
      diff: "+import { save } from \"./save\"\n+save(value)",
    },
  ]);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.needsVerification, []);
});

test("an untyped TypeScript optional parameter preserves the old call", () => {
  const result = analyze([
    {
      number: 325, title: "optional signal", ciPassed: true, mergeable: true, files: ["src/runtime.ts"],
      diff: "-async function callTool(server, tool, input) {\n+async function callTool(server, tool, input, signal?) {",
    },
    {
      number: 326, title: "three argument call", ciPassed: true, mergeable: true, files: ["src/use.ts"],
      diff: "+import { callTool } from \"./runtime\"\n+callTool(server, tool, input)",
    },
  ]);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.needsVerification, []);
});

test("plain JavaScript arity changes require runtime verification", () => {
  const result = analyze([
    {
      number: 331, title: "change JS API", ciPassed: true, mergeable: true, files: ["src/format.js"],
      diff: "-export function format(value) {\n+export function format(value, locale) {",
    },
    {
      number: 332, title: "old JS call", ciPassed: true, mergeable: true, files: ["src/use.js"],
      diff: "+import { format } from \"./format\"\n+format(value)",
    },
  ]);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.needsVerification.length, 1);
  assert.equal(result.needsVerification[0].reasonCode, "runtime_contract");
});

test("same-file contract evidence requires pair text-merge verification", () => {
  const result = analyze([
    {
      number: 336, title: "change API", ciPassed: true, mergeable: true, files: ["src/format.ts"],
      diff: "-export function format(value: string) {\n+export function format(value: string, locale: string) {",
    },
    {
      number: 337, title: "change old call", ciPassed: true, mergeable: true, files: ["src/format.ts"],
      diff: "+const preview = format(value)",
    },
  ]);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.needsVerification.length, 1);
  assert.equal(result.needsVerification[0].reasonCode, "pair_merge_required");
});

test("Python relative imports produce a qualified static conflict", () => {
  const result = analyze([
    {
      number: 341, title: "require locale", ciPassed: true, mergeable: true, files: ["src/util/format.py"],
      diff: "-def render(value):\n+def render(value, locale):",
    },
    {
      number: 342, title: "add page", ciPassed: true, mergeable: true, files: ["src/views/page.py"],
      diff: "+from ..util.format import render\n+title = render(value)",
    },
  ]);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].sharedResources, ["api:src/util/format#render"]);
});

test("config key replacement and old-key reader are queued for merge verification", () => {
  const result = analyze([
    {
      number: 351, title: "rename token key", ciPassed: true, mergeable: true, files: ["src/config.ts"],
      diff: "-const token = process.env.OLD_TOKEN\n+const token = process.env.NEW_TOKEN",
    },
    {
      number: 352, title: "add token consumer", ciPassed: true, mergeable: true, files: ["src/worker.ts"],
      diff: "+const token = process.env.OLD_TOKEN",
    },
  ]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].evidenceStrength, "medium");
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.needsVerification.length, 1);
  assert.deepEqual(result.needsVerification[0].sharedResources, ["config:OLD_TOKEN"]);
});

test("event rename and old listener are queued for merge verification", () => {
  const result = analyze([
    {
      number: 361, title: "rename event", ciPassed: true, mergeable: true, files: ["src/events.ts"],
      diff: "-bus.emit(\"session.ready\")\n+bus.emit(\"session.started\")",
    },
    {
      number: 362, title: "listen to event", ciPassed: true, mergeable: true, files: ["src/listener.ts"],
      diff: "+bus.on(\"session.ready\", handleReady)",
    },
  ]);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.needsVerification.length, 1);
  assert.deepEqual(result.needsVerification[0].sharedResources, ["event:session.ready"]);
});

test("call-call name overlap does not create a candidate without a contract change", () => {
  const cards = [
    extractIntentCard({ number: 371, title: "tests A", ciPassed: true, mergeable: true, files: ["a.ts"], diff: "+expect(value).toBe(true)" }),
    extractIntentCard({ number: 372, title: "tests B", ciPassed: true, mergeable: true, files: ["b.ts"], diff: "+expect(other).toBe(false)" }),
  ];
  assert.deepEqual(generateCandidates(cards), []);
});

test("generic unresolved API names do not pollute the cross-PR verification queue", () => {
  const result = analyze([
    {
      number: 375, title: "change one init", ciPassed: true, mergeable: true, files: ["src/a.ts"],
      diff: "-export function init(value: string) {\n+export function init(value: string, options: object) {",
    },
    {
      number: 376, title: "call another init", ciPassed: true, mergeable: true, files: ["src/b.ts"],
      diff: "+other.init(value)",
    },
  ]);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.needsVerification, []);
});

test("calls written only in comments are ignored", () => {
  const card = extractIntentCard({ number: 381, title: "docs", ciPassed: true, mergeable: true, files: ["a.ts"], diff: "+// callOld(value) is mentioned here" });
  assert.deepEqual(card.touchedResources, []);
});

test("a migration call inside the definition PR cannot implicate another PR", () => {
  const result = analyze([
    {
      number: 391, title: "change contract", ciPassed: true, mergeable: true, files: ["api.ts"],
      diff: "-export function save(value: string) {\n+export function save(value: string, options: object) {\n+save(legacyValue)",
    },
    {
      number: 392, title: "use new contract", ciPassed: true, mergeable: true, files: ["caller.ts"],
      diff: "+import { save } from \"./api\"\n+save(value, {})",
    },
  ]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.conflicts.length, 0);
});
