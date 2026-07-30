const TEST_PATH = /(^|\/)(?:test|tests)(?:\/|_|\.)|\.(?:test|spec)\./i;
const FIX_TITLE = /^(?:fix|bug)\b|\b(?:bugfix|regression|crash|warning|incorrect|unnecessary|spurious)\b/i;
const REFACTOR_TITLE = /^(?:prf|mnt|refactor)\b|\b(?:refactor|simplif(?:y|ication)|rewrite|cleanup)\b/i;

const uniq = (values) => [...new Set(values.filter(Boolean))];
const intersect = (left, right) => { const set = new Set(right); return uniq(left.filter((value) => set.has(value))); };

function issueRefs(pr) {
  const text = `${pr.title || ""}\n${pr.body || ""}`;
  return uniq([...text.matchAll(/\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi)].map((match) => match[1]));
}

function intent(pr) {
  const title = (pr.title || "").trim();
  return {
    fix: FIX_TITLE.test(title) || issueRefs(pr).length > 0,
    refactor: REFACTOR_TITLE.test(title),
  };
}

function filesOnPaths(pr, paths) {
  const pathSet = new Set(paths);
  return pr.changeModel.files.filter((file) => pathSet.has(file.filename));
}

function addedDeclarations(pr, paths) {
  return uniq(filesOnPaths(pr, paths).flatMap((file) => file.addedDeclarations.map((item) => item.name)));
}

function addedTestPaths(pr) {
  return pr.changeModel.files.filter((file) => TEST_PATH.test(file.filename) && file.addedLines.length).map((file) => file.filename);
}

function evidence(id, kind, summary, values) {
  return { id, kind, summary, evidence: uniq(values).slice(0, 8) };
}

export function explainCoordination(comparison, inspection, prsById) {
  const left = prsById.get(comparison.prIds[0]);
  const right = prsById.get(comparison.prIds[1]);
  const paths = inspection.conflictPaths || [];
  if (!left || !right) return { coordinationSubtype: null, requiredAction: "resolve-textual-conflict", actionConfidence: "low", explanationEvidence: [] };

  const leftIntent = intent(left);
  const rightIntent = intent(right);
  const sharedIssues = intersect(issueRefs(left), issueRefs(right));
  const competing = comparison.witnesses.filter((witness) => witness.type === "competing-replacement");
  const leftDeclarations = addedDeclarations(left, paths);
  const rightDeclarations = addedDeclarations(right, paths);
  const sharedDeclarations = intersect(leftDeclarations, rightDeclarations);
  const distinctLeftDeclarations = leftDeclarations.filter((name) => !sharedDeclarations.includes(name));
  const distinctRightDeclarations = rightDeclarations.filter((name) => !sharedDeclarations.includes(name));
  const leftTests = addedTestPaths(left);
  const rightTests = addedTestPaths(right);
  const sharedTestPaths = intersect(leftTests, rightTests);

  const duplicateSignals = [
    leftIntent.fix && rightIntent.fix ? 2 : 0,
    sharedIssues.length ? 2 : 0,
    distinctLeftDeclarations.length && distinctRightDeclarations.length ? 2 : 0,
    sharedTestPaths.length ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0);
  if (competing.length && duplicateSignals >= 5) {
    const explanationEvidence = [
      evidence("C1", "competing-replacement", "Both PRs replace the same existing call site differently.", competing.flatMap((item) => item.evidence)),
      evidence("C2", "parallel-helpers", "The conflicting files introduce different new helpers.", [...distinctLeftDeclarations, ...distinctRightDeclarations]),
      ...(sharedIssues.length ? [evidence("C3", "shared-issue", "Both PRs claim to solve the same issue.", sharedIssues.map((issue) => `#${issue}`))] : []),
      ...(sharedTestPaths.length ? [evidence("C4", "shared-test-surface", "Both PRs add coverage to the same test surface.", sharedTestPaths)] : []),
    ];
    return {
      coordinationSubtype: "duplicate-implementation",
      requiredAction: "deduplicate",
      actionConfidence: "high",
      title: `Duplicate implementations must be consolidated${paths.length ? `: ${paths.slice(0, 2).join(", ")}` : ""}`,
      summary: "Both PRs solve the same problem and call site with different helpers. Removing conflict markers alone may leave dead code or duplicate validation.",
      consequence: "Keeping both implementations may leave duplicate branches, duplicate warnings, or unused helpers.",
      recommendation: "Choose one implementation and consolidate the call sites, helper, and tests around it. Close the other PR or rebase it onto the selected implementation.",
      validStrategies: ["select-one-implementation", "merge-smaller-then-consolidate-superset"],
      invalidOutcome: "retain-both-helpers",
      explanationEvidence,
    };
  }

  const fixSide = leftIntent.fix !== rightIntent.fix ? (leftIntent.fix ? left : right) : null;
  const otherSide = fixSide === left ? right : fixSide === right ? left : null;
  const fixTests = fixSide ? addedTestPaths(fixSide) : [];
  const otherIntent = otherSide ? intent(otherSide) : null;
  const largerRewrite = fixSide && otherSide ? otherSide.deletions > fixSide.deletions * 2 || otherIntent.refactor : false;
  if (competing.length && fixSide && fixTests.length && largerRewrite) {
    const explanationEvidence = [
      evidence("C1", "competing-replacement", "A refactor and a bug fix replace the same existing behavior differently.", competing.flatMap((item) => item.evidence)),
      evidence("C2", "regression-tests", `PR #${fixSide.number} adds regression tests.`, fixTests),
      evidence("C3", "rewrite-scope", `The larger rewrite in PR #${otherSide.number} may overwrite the corrected behavior.`, paths),
    ];
    return {
      coordinationSubtype: "resolution-risk",
      requiredAction: "preserve-regression-fix",
      actionConfidence: "high",
      title: `Bug fix may be lost during conflict resolution${paths.length ? `: ${paths.slice(0, 2).join(", ")}` : ""}`,
      summary: `The bug fix and regression tests in PR #${fixSide.number} conflict with the larger rewrite in PR #${otherSide.number}. Selecting only the rewrite may erase the fix's intent.`,
      consequence: "The Git conflict may be resolved while silently omitting the behavior protected by the regression test.",
      recommendation: `Keep the regression tests from PR #${fixSide.number} and port the fix into the rewritten result until those tests pass.`,
      protectedPrNumber: fixSide.number,
      explanationEvidence,
    };
  }

  return {
    coordinationSubtype: null,
    requiredAction: "resolve-textual-conflict",
    actionConfidence: "low",
    explanationEvidence: [evidence("C1", "merge-tree", "A textual conflict is confirmed, but semantic evidence is insufficient to choose a resolution strategy.", paths)],
  };
}
