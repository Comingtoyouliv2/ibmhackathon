import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractSignals } from "../src/analyzer.mjs";
import { DEFAULT_ADAPTERS, languageForFile } from "../src/adapters/registry.mjs";
import { SCIR_SCHEMA_VERSION, validateChangeSet } from "../src/scir/index.mjs";

const pr = (id, files) => ({ id, number: Number(id) || 1, title: `PR ${id}`, files });
const file = (filename, patch) => ({ filename, status: "modified", patch });

test("SCIR JSON schema and runtime contract share one version", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/ar-scs-v0.1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, SCIR_SCHEMA_VERSION);
  assert.ok(schema.required.includes("operations"));
  assert.ok(schema.required.includes("dependencies"));
  assert.ok(schema.required.includes("evidence"));
});

test("adapter registry emits stable valid SCIR ids", () => {
  const input = pr("stable", [file("src/main/java/demo/Service.java", "@@ -2,1 +2,1 @@\n-import old.Api;\n+import newpkg.Api;")]);
  const first = extractSignals(input).scir;
  const second = extractSignals(input).scir;
  assert.deepEqual(first, second);
  assert.equal(validateChangeSet(first).valid, true);
  assert.deepEqual(first.adapters, ["generic-diff-v0.1", "java-v0.1"]);
  assert.deepEqual(first.languages, ["java"]);
});

test("Java adapter represents import lifecycle and binding requirements", () => {
  const model = extractSignals(pr("java", [file(
    "src/main/java/ninja/ContextImpl.java",
    "@@ -2,1 +2,1 @@\n-import javax.servlet.http.Cookie;\n+response.addCookie(new Cookie(name, null));",
  )]));
  const removed = model.scir.operations.find((operation) => operation.kind === "remove" && operation.metadata.adapterId === "java-v0.1");
  const required = model.scir.dependencies.find((dependency) => dependency.relation === "requires-binding" && dependency.target.name === "Cookie");
  assert.equal(removed.metadata.qualified, "javax.servlet.http.Cookie");
  assert.equal(removed.metadata.conflictEligible, true);
  assert.equal(removed.metadata.deterministicEligible, true);
  assert.equal(required.target.scope, "src/main/java/ninja/ContextImpl.java");
  assert.equal(required.proofGrade, "structural");
});

test("unbenchmarked language adapters emit review-only structural policy", () => {
  const model = extractSignals(pr("python", [file("service.py", "@@ -1,1 +1,0 @@\n-from legacy.cookies import Cookie") ]));
  const removed = model.scir.operations.find((operation) => operation.kind === "remove" && operation.metadata.adapterId === "python-v0.1");
  assert.equal(removed.proofGrade, "structural");
  assert.equal(removed.metadata.deterministicEligible, false);
});

test("generic adapter represents inferred rename and net-new reference", () => {
  const model = extractSignals(pr("rename", [
    file("RemoteNode.java", "@@ -10,2 +10,2 @@\n-public Location location;\n-return location.hashCode();\n+public Location physicalLocation;\n+return physicalLocation.hashCode();"),
    file("Session.java", "@@ -20,0 +21,1 @@\n+connections.remove(address.location);"),
  ]));
  const rename = model.scir.operations.find((operation) => operation.kind === "rename");
  const reference = model.scir.dependencies.find((dependency) => dependency.relation === "references" && dependency.target.name === "location");
  assert.equal(rename.before, "location");
  assert.equal(rename.after, "physicalLocation");
  assert.equal(rename.proofGrade, "structural");
  assert.equal(reference.metadata.member, true);
});

test("custom adapters can be supplied without changing core analyzer code", () => {
  const custom = {
    id: "custom-empty-v0.1",
    supports: ({ language }) => language === "python",
    extract: ({ language }) => ({ adapterId: "custom-empty-v0.1", language, entities: [], operations: [], dependencies: [], assumptions: [], evidence: [] }),
  };
  const model = extractSignals(pr("custom", [file("service.py", "@@ -1,0 +1,1 @@\n+enabled = True")]), { adapters: [...DEFAULT_ADAPTERS, custom] });
  assert.ok(model.scir.adapters.includes("custom-empty-v0.1"));
  assert.equal(validateChangeSet(model.scir).valid, true);
});

test("language registry has generic fallback for unsupported extensions", () => {
  assert.equal(languageForFile("main.go"), "go");
  assert.equal(languageForFile("rules.unknown"), "unknown");
  const model = extractSignals(pr("unknown", [file("rules.unknown", "@@ -0,0 +1,1 @@\n+value")]), { adapters: [{
    id: "fallback-v0.1",
    supports: () => true,
    extract: ({ language }) => ({ adapterId: "fallback-v0.1", language, entities: [], operations: [], dependencies: [], assumptions: [], evidence: [] }),
  }] });
  assert.deepEqual(model.scir.adapters, ["fallback-v0.1"]);
  assert.deepEqual(model.scir.languages, ["unknown"]);
});

test("runtime validation rejects dangling evidence references", () => {
  const invalid = {
    schemaVersion: SCIR_SCHEMA_VERSION,
    changeSetId: "bad",
    adapters: ["bad-v0.1"], languages: ["unknown"], entities: [], assumptions: [], evidence: [], dependencies: [],
    operations: [{ id: "op", kind: "add", entityId: "missing", before: null, after: null, evidenceIds: ["missing"], proofGrade: "structural", metadata: {} }],
  };
  const result = validateChangeSet(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("missing entity")));
  assert.ok(result.errors.some((error) => error.includes("invalid evidence refs")));
});
