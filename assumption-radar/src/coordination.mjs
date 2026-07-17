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
      evidence("C1", "competing-replacement", "두 PR이 같은 기존 호출부를 서로 다르게 교체합니다.", competing.flatMap((item) => item.evidence)),
      evidence("C2", "parallel-helpers", "충돌 파일에 서로 다른 새 helper를 추가합니다.", [...distinctLeftDeclarations, ...distinctRightDeclarations]),
      ...(sharedIssues.length ? [evidence("C3", "shared-issue", "두 PR이 같은 이슈를 해결한다고 선언합니다.", sharedIssues.map((issue) => `#${issue}`))] : []),
      ...(sharedTestPaths.length ? [evidence("C4", "shared-test-surface", "같은 테스트 표면에 각각 검증을 추가합니다.", sharedTestPaths)] : []),
    ];
    return {
      coordinationSubtype: "duplicate-implementation",
      requiredAction: "deduplicate",
      actionConfidence: "high",
      title: `중복 구현을 하나로 통합해야 함${paths.length ? `: ${paths.slice(0, 2).join(", ")}` : ""}`,
      summary: "두 PR은 같은 문제와 호출부를 서로 다른 helper로 해결합니다. 충돌 마커만 제거하면 양쪽 helper가 함께 남아 죽은 코드나 이중 검증이 생길 수 있습니다.",
      consequence: "두 구현을 모두 보존하면 중복 분기, 이중 경고 또는 사용되지 않는 helper가 남을 수 있습니다.",
      recommendation: "유지할 구현 하나를 선택하고 호출부·helper·테스트를 그 구현으로 통합하세요. 다른 PR은 닫거나 선택된 구현 위로 리베이스하세요.",
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
      evidence("C1", "competing-replacement", "리팩터링과 bug fix가 같은 기존 동작을 서로 다르게 교체합니다.", competing.flatMap((item) => item.evidence)),
      evidence("C2", "regression-tests", `PR #${fixSide.number}가 회귀 테스트를 추가합니다.`, fixTests),
      evidence("C3", "rewrite-scope", `PR #${otherSide.number}의 더 큰 rewrite가 수정 동작을 덮을 수 있습니다.`, paths),
    ];
    return {
      coordinationSubtype: "resolution-risk",
      requiredAction: "preserve-regression-fix",
      actionConfidence: "high",
      title: `충돌 해소 중 bug fix 유실 위험${paths.length ? `: ${paths.slice(0, 2).join(", ")}` : ""}`,
      summary: `PR #${fixSide.number}의 bug fix와 회귀 테스트가 더 큰 rewrite PR #${otherSide.number}와 충돌합니다. rewrite 쪽만 선택하면 수정 의도가 사라질 수 있습니다.`,
      consequence: "Git 충돌은 해결돼도 회귀 테스트가 보호하는 동작이 구현에서 빠지는 조용한 회귀가 생길 수 있습니다.",
      recommendation: `PR #${fixSide.number}의 회귀 테스트를 유지하고, 그 테스트가 통과하도록 수정 로직을 rewrite 결과에 이식하세요.`,
      protectedPrNumber: fixSide.number,
      explanationEvidence,
    };
  }

  return {
    coordinationSubtype: null,
    requiredAction: "resolve-textual-conflict",
    actionConfidence: "low",
    explanationEvidence: [evidence("C1", "merge-tree", "텍스트 충돌은 확인됐지만 해결 전략을 확정할 의미 증거는 부족합니다.", paths)],
  };
}
