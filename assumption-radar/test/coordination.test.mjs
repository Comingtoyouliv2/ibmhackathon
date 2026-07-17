import test from "node:test";
import assert from "node:assert/strict";
import { prepareAnalysis } from "../src/analyzer.mjs";
import { explainCoordination } from "../src/coordination.mjs";

const file = (filename, patch) => ({ filename, status: "modified", patch });
const pr = (id, title, body, files, extra = {}) => ({ id, number: Number(id), title, body, files, ...extra });

function explain(prs, path = "core.py") {
  const prepared = prepareAnalysis(prs);
  return explainCoordination(
    prepared.comparisons[0],
    { status: "textual-conflict", conflictPaths: [path] },
    new Map(prepared.prs.map((item) => [item.id, item])),
  );
}

test("coordination explainer detects parallel duplicate implementations", () => {
  const left = pr("1", "FIX avoid warning in boolean metrics", "Fixes #42", [
    file("core.py", "@@ -10,1 +10,1 @@ def choose_metric():\n-X, Y = check_pairwise_arrays(X, Y)\n+X, Y = _ensure_bool_metric(X, Y)\n@@ -1,0 +2,2 @@\n+def _ensure_bool_metric(X, Y):\n+    return X, Y"),
    file("tests/test_core.py", "@@ -1,0 +2,2 @@\n+def test_boolean_metric_no_warning():\n+    assert True"),
  ], { additions: 20, deletions: 1 });
  const right = pr("2", "Remove unnecessary conversion for boolean metrics", "Resolves #42", [
    file("core.py", "@@ -10,1 +10,1 @@ def choose_metric():\n-X, Y = check_pairwise_arrays(X, Y)\n+X, Y = _check_scipy_metric(X, Y)\n@@ -1,0 +2,2 @@\n+def _check_scipy_metric(X, Y):\n+    return X, Y"),
    file("tests/test_core.py", "@@ -5,0 +6,2 @@\n+def test_boolean_metric_dtype():\n+    assert True"),
  ], { additions: 30, deletions: 2 });
  const result = explain([left, right]);
  assert.equal(result.coordinationSubtype, "duplicate-implementation");
  assert.equal(result.requiredAction, "deduplicate");
  assert.equal(result.actionConfidence, "high");
  assert.ok(result.explanationEvidence.some((item) => item.kind === "shared-issue"));
  assert.ok(result.explanationEvidence.some((item) => item.kind === "parallel-helpers"));
});

test("coordination explainer protects a regression fix from a larger rewrite", () => {
  const refactor = pr("1", "PRF rewrite encoder lookup", "Simplify the encoding path", [
    file("core.py", "@@ -10,1 +10,1 @@ def encode():\n-return legacy_encode(values)\n+return rewritten_encode(values)"),
  ], { additions: 80, deletions: 100 });
  const fix = pr("2", "FIX crash for object categories", "Fixes #99", [
    file("core.py", "@@ -10,1 +10,1 @@ def encode():\n-return legacy_encode(values)\n+return safe_encode(values)"),
    file("tests/test_core.py", "@@ -1,0 +2,2 @@\n+def test_object_category_regression():\n+    assert True"),
  ], { additions: 10, deletions: 2 });
  const result = explain([refactor, fix]);
  assert.equal(result.coordinationSubtype, "resolution-risk");
  assert.equal(result.requiredAction, "preserve-regression-fix");
  assert.equal(result.protectedPrNumber, 2);
  assert.ok(result.explanationEvidence.some((item) => item.kind === "regression-tests"));
});

test("coordination explainer abstains when subtype evidence is weak", () => {
  const result = explain([
    pr("1", "Update calculation A", "", [file("core.py", "@@ -10,1 +10,1 @@ def total():\n-return base_amount\n+return taxed_amount")]),
    pr("2", "Update calculation B", "", [file("core.py", "@@ -10,1 +10,1 @@ def total():\n-return base_amount\n+return discounted_amount")]),
  ]);
  assert.equal(result.coordinationSubtype, null);
  assert.equal(result.requiredAction, "resolve-textual-conflict");
  assert.equal(result.actionConfidence, "low");
});
