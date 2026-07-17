import test from "node:test";
import assert from "node:assert/strict";
import { classifyCombinedRuns, failureSignatures } from "../src/combined-verifier.mjs";
import { prepareIntegratedAnalysis, prepareIntentPrototypeAnalysis } from "../src/integrated.mjs";

const pr = (id, file, patch, title = `PR ${id}`) => ({ id, number: Number(id), title, baseSha: "base", files: [{ filename: file, status: "modified", patch }] });

test("intent retrieval ranks same-module pairs above isolated pairs without inventing blocker verdicts", () => {
  const prs = [
    pr("1", "modules/a/src/Service.java", "@@ -1 +1 @@\n-old()\n+newer()"),
    pr("2", "modules/a/src/Other.java", "@@ -1 +1 @@\n-before()\n+after()"),
    pr("3", "modules/b/src/Else.java", "@@ -1 +1 @@\n-left()\n+right()"),
  ];
  const prepared = prepareIntentPrototypeAnalysis(prs);
  assert.deepEqual(new Set(prepared.comparisons[0].prIds), new Set(["1", "2"]));
  assert.equal(prepared.comparisons[0].verdict, "review");
});

test("patch write-read interaction improves retrieval without inventing a semantic verdict", () => {
  const prepared = prepareIntegratedAnalysis([
    pr("1", "src/Cache.java", "@@ -10 +10 @@\n-old\n+cache.setReady(true);"),
    pr("2", "src/Cache.java", "@@ -20 +20 @@\n-old\n+if (cache.getReady()) { return; }"),
  ]);
  assert.equal(prepared.comparisons[0].verdict, "independent");
  assert.ok(prepared.comparisons[0].witnesses.some((witness) => witness.type === "patch-write-read"));
  assert.ok(prepared.comparisons[0].retrievalScore > 0);
});

test("combined verifier requires independent passes and a repeated failure signature", () => {
  const result = classifyCombinedRuns({
    base: { status: "passed" }, a: { status: "passed" }, b: { status: "passed" },
    combined: { status: "failed", output: "error[E100]: missing field 12" },
    confirmation: { status: "failed", output: "error[E100]: missing field 99" },
  });
  assert.equal(result.verdict, "conflict");
  assert.deepEqual(failureSignatures("panic at 0xabc line 42"), ["panic at 0x# line #"]);
});
