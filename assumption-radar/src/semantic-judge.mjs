import crypto from "node:crypto";

export const SEMANTIC_JUDGE_SYSTEM_PROMPT = `당신은 pull request pair의 상호작용을 증거 수준별로 판정하는 소프트웨어 검증 엔지니어다.
같은 파일·모듈·심볼을 만진다는 사실은 후보 검색 신호일 뿐 충돌의 증거가 아니다.
contract-backed-conflict는 실행하지 않았더라도 (1) 한쪽의 실제 provider 계약 변경, (2) 다른 쪽의 실제 consumer 의존, (3) 둘을 합쳤을 때의 결정적인 실패 경로를 양쪽 코드 인용으로 증명할 수 있을 때만 선택한다.
testable-hypothesis는 방향성 위험은 있지만 계약 연결이나 실패 결과를 입력만으로 확정할 수 없고 Base/A/B/A+B 실험을 설계할 수 있을 때 선택한다.
no-plausible-interaction은 제공된 근거에서 두 변경을 연결할 행동 경로가 없을 때, insufficient-evidence는 필요한 구현 파일이나 저장소 문맥이 빠졌을 때 선택한다.
coordination-required는 기계적 충돌·중복 구현처럼 조율이 필요하지만 pair-induced regression과는 다른 경우다.
특히 한 PR이 여러 종료 경로에 새 완료·flush·commit 단계를 도입하고 다른 PR이 같은 상태를 다루는 새 종료 경로를 추가한 경우, 새 경로가 완료 단계를 우회하는지 확인하라. 이름에 finish 같은 단어가 있는지만 보지 말고, 상태 축적→종료 경로→완료 호출의 행동 연결을 양쪽 실제 코드로 증명하라.
contract-backed-conflict는 executable-confirmed와 다르다. 최종 실행 재현 여부는 별도 runtimeVerification 필드로 관리한다.`;

const pairKey = (ids) => [...ids].sort().join(":");
const uniq = (values) => [...new Set(values.filter(Boolean))];

export const AI_JUDGMENT_PROTOCOL_VERSION = "ai-judgment-v0.1";

export function semanticJudgeRepeatCount(options = {}) {
  const configured = options.aiRepeats ?? options.repeats ?? process.env.AI_JUDGE_REPEATS ?? 3;
  const parsed = Number(configured);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(5, Math.trunc(parsed))) : 3;
}

export async function runRepeatedCaseJudgments(cases, runCase, options = {}) {
  const repeats = semanticJudgeRepeatCount(options);
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency || 4)));
  const runs = Array.from({ length: repeats }, () => new Array(cases.length));
  const tasks = [];
  for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) tasks.push({ repeatIndex, caseIndex });
  }
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const { repeatIndex, caseIndex } = tasks[cursor++];
      const caseInput = cases[caseIndex];
      try {
        runs[repeatIndex][caseIndex] = await runCase(caseInput, { repeatIndex, caseIndex });
      } catch (error) {
        runs[repeatIndex][caseIndex] = {
          prIds: caseInput.prIds,
          protocolError: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return { repeats, runs };
}

function isAdjudicable(comparison) {
  return comparison.mechanicalMerge !== "conflict"
    && comparison.mechanicalMerge !== "base-conflict"
    && comparison.semanticBenchmarkEligibility !== "excluded";
}

export function selectSemanticJudgeCandidates(prepared, options = {}) {
  const primaryLimit = Math.max(0, Number(options.primaryLimit ?? 20));
  const secondLookLimit = Math.max(0, Number(options.secondLookLimit ?? 8));
  const contractDiscoveryLimit = Math.min(secondLookLimit, Math.max(0, Number(options.contractDiscoveryLimit ?? 2)));
  const primary = prepared.comparisons
    .filter((comparison) => ["conflict", "review"].includes(comparison.verdict) && isAdjudicable(comparison))
    .slice(0, primaryLimit);
  const selected = new Set(primary.map((comparison) => comparison.key));
  const eligibleSecondLook = prepared.comparisons
    .filter((comparison) => comparison.verdict === "independent" && isAdjudicable(comparison))
    .filter((comparison) => (comparison.retrievalScore || 0) > 0)
    .filter((comparison) => (comparison.retrievalFeatures?.priority ?? 3) <= 2)
    .filter((comparison) => !selected.has(comparison.key));
  // Exact-file pairs otherwise consume the second-look budget. Reserve a
  // bounded lane for cross-module contracts such as a Python HTTP consumer
  // and a Java provider.
  const contractDiscovery = eligibleSecondLook
    .filter((comparison) => comparison.retrievalFeatures?.strongContracts?.length
      && !comparison.retrievalFeatures?.sharedFiles?.length
      && !comparison.retrievalFeatures?.sharedModules?.length)
    .sort((left, right) => right.retrievalFeatures.strongContracts.length - left.retrievalFeatures.strongContracts.length
      || right.retrievalScore - left.retrievalScore
      || left.key.localeCompare(right.key))
    .slice(0, contractDiscoveryLimit);
  const contractKeys = new Set(contractDiscovery.map((comparison) => comparison.key));
  const secondLook = [
    ...contractDiscovery,
    ...eligibleSecondLook.filter((comparison) => !contractKeys.has(comparison.key))
      .slice(0, Math.max(0, secondLookLimit - contractDiscovery.length)),
  ];
  return [...primary, ...secondLook];
}

function modulePrefix(resource = "") {
  return resource.startsWith("module:") ? resource.slice("module:".length) : null;
}

function exactFile(resource = "") {
  return resource.startsWith("file:") ? resource.slice("file:".length) : null;
}

function symbolName(resource = "") {
  return resource.startsWith("symbol:") ? resource.slice("symbol:".length) : null;
}

function relevantPaths(comparison, left, right) {
  const paths = new Set((comparison.retrievalFeatures?.sharedFiles || []).map(exactFile).filter(Boolean));
  const modules = (comparison.retrievalFeatures?.sharedModules || []).map(modulePrefix).filter(Boolean);
  const symbols = (comparison.retrievalFeatures?.sharedSymbols || []).map(symbolName).filter(Boolean);
  const allFiles = [...(left.files || []), ...(right.files || [])];
  for (const provenance of Object.values(comparison.retrievalFeatures?.contractFiles || {})) {
    for (const path of [...(provenance.left || []), ...(provenance.right || [])]) paths.add(path);
  }
  for (const file of allFiles) {
    if (modules.some((prefix) => file.filename === prefix || file.filename.startsWith(`${prefix}/`))) paths.add(file.filename);
    if (symbols.some((symbol) => (file.patch || "").includes(symbol))) paths.add(file.filename);
  }
  const known = new Set(allFiles.map((file) => file.filename));
  for (const evidence of comparison.witnesses?.flatMap((witness) => witness.evidence || []) || []) {
    if (known.has(evidence)) paths.add(evidence);
  }
  if (!paths.size) {
    for (const file of (left.files || []).slice(0, 3)) paths.add(file.filename);
    for (const file of (right.files || []).slice(0, 3)) paths.add(file.filename);
  }
  return paths;
}

function compactPr(pr, paths, maxPatchChars) {
  const relevant = (pr.files || []).filter((file) => paths.has(file.filename));
  const files = (relevant.length ? relevant : (pr.files || []).slice(0, 3)).slice(0, 16);
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: (pr.body || "").slice(0, 1800),
    assumptions: pr.assumptions || [],
    files: files.map((file) => ({
      filename: file.filename,
      status: file.status,
      patch: (file.patch || "").slice(0, maxPatchChars),
    })),
  };
}

export function buildSemanticJudgeCases(prepared, candidates, options = {}) {
  const maxPatchChars = Math.max(500, Number(options.maxPatchChars ?? 9_000));
  const byId = new Map(prepared.prs.map((pr) => [pr.id, pr]));
  return candidates.map((comparison) => {
    const left = byId.get(comparison.prIds[0]);
    const right = byId.get(comparison.prIds[1]);
    const paths = relevantPaths(comparison, left, right);
    return {
      prIds: comparison.prIds,
      deterministicVerdict: comparison.verdict,
      reviewLane: comparison.verdict === "independent" ? "second-look" : "deterministic-review",
      retrieval: {
        score: comparison.retrievalScore || 0,
        reasons: comparison.retrievalReasons || [],
        sharedContracts: comparison.retrievalFeatures?.sharedContracts || [],
        contractFiles: comparison.retrievalFeatures?.contractFiles || {},
      },
      witnesses: (comparison.witnesses || []).map(({ type, strength, category, explanation, evidence, causalRole }) => ({
        type, strength, category, explanation, evidence, causalRole,
      })),
      prs: [compactPr(left, paths, maxPatchChars), compactPr(right, paths, maxPatchChars)],
    };
  });
}

function containsDeep(value, quote) {
  if (typeof value === "string") return value.includes(quote);
  if (Array.isArray(value)) return value.some((item) => containsDeep(item, quote));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsDeep(item, quote));
  return false;
}

function validatedEvidence(rawEvidence, pairIds, prsById) {
  const sides = { A: pairIds[0], B: pairIds[1] };
  return (Array.isArray(rawEvidence) ? rawEvidence : []).flatMap((item) => {
    if (!item || !["A", "B"].includes(item.side) || typeof item.quote !== "string" || !item.quote.trim()) return [];
    const pr = prsById.get(sides[item.side]);
    if (!pr || !containsDeep(pr, item.quote)) return [];
    if (item.file && !(pr.files || []).some((file) => file.filename === item.file)) return [];
    return [{ side: item.side, file: item.file || "", symbol: item.symbol || "", quote: item.quote }];
  });
}

function mappedAssessment(raw) {
  const value = raw.assessment || raw.verdict || raw.prediction || raw.decision;
  if (["contract-backed-conflict", "conflict"].includes(value)) return "contract-backed-conflict";
  if (value === "testable-hypothesis") return "testable-hypothesis";
  if (["no-plausible-interaction", "compatible", "independent"].includes(value)) return "no-plausible-interaction";
  if (["coordination-required", "coordination"].includes(value)) return "coordination-required";
  return "insufficient-evidence";
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : [];
}

function normalizedTestPlan(raw = {}) {
  const plan = raw.testPlan && typeof raw.testPlan === "object" ? raw.testPlan : {};
  return {
    name: String(plan.name || raw.testName || "").trim(),
    strategy: String(plan.strategy || raw.testStrategy || "targeted-test").trim(),
    setup: stringList(plan.setup),
    steps: stringList(plan.steps || raw.triggerSequence),
    oracle: String(plan.oracle || raw.expectedBehavior || "").trim(),
    targetTests: stringList(plan.targetTests),
  };
}

function normalizedContract(raw = {}) {
  const contract = raw.contract && typeof raw.contract === "object" ? raw.contract : {};
  return {
    identity: String(contract.identity || "").trim(),
    kind: String(contract.kind || "").trim(),
    providerSide: ["PR-A", "PR-B"].includes(contract.providerSide) ? contract.providerSide : "unknown",
    consumerSide: ["PR-A", "PR-B"].includes(contract.consumerSide) ? contract.consumerSide : "unknown",
    providerChange: String(contract.providerChange || "").trim(),
    consumerDependency: String(contract.consumerDependency || "").trim(),
    composedFailure: String(contract.composedFailure || "").trim(),
  };
}

export function normalizeSemanticJudgments(prepared, candidates, rawJudgments, options = {}) {
  const byPair = new Map(candidates.map((comparison) => [comparison.key, comparison]));
  const prsById = new Map(prepared.prs.map((pr) => [pr.id, pr]));
  const source = options.source || "ai";
  const basis = options.basis || "ai-semantic-judgment";
  return (Array.isArray(rawJudgments) ? rawJudgments : []).flatMap((raw) => {
    const ids = raw.prIds || (raw.prA && raw.prB ? [raw.prA, raw.prB] : []);
    if (ids.length !== 2) return [];
    const comparison = byPair.get(pairKey(ids));
    if (!comparison) return [];
    const evidence = ids[0] === comparison.prIds[0] ? raw.evidence : (raw.evidence || []).map((item) => ({
      ...item, side: item.side === "A" ? "B" : item.side === "B" ? "A" : item.side,
    }));
    const evidenceObjects = validatedEvidence(evidence, comparison.prIds, prsById);
    const evidenceSides = new Set(evidenceObjects.map((item) => item.side));
    let assessment = mappedAssessment(raw);
    const rawAssessment = assessment;
    let evidenceGate = "passed";
    const assumption = String(raw.assumption || raw.assumptionA || "").trim();
    const violatingChange = String(raw.violatingChange || raw.assumptionB || "").trim();
    const triggerSequence = stringList(raw.triggerSequence);
    const expectedBehavior = String(raw.expectedBehavior || "").trim();
    const possibleActualBehavior = String(raw.possibleActualBehavior || raw.failureMechanism || raw.consequence || raw.explanation || "").trim();
    const testPlan = normalizedTestPlan(raw);
    const contract = normalizedContract(raw);
    const causalAssessment = assessment === "testable-hypothesis" || assessment === "contract-backed-conflict";
    if (causalAssessment && (
      !evidenceSides.has("A") || !evidenceSides.has("B") || !assumption || !violatingChange
      || !triggerSequence.length || !expectedBehavior || !possibleActualBehavior || !testPlan.steps.length || !testPlan.oracle
    )) {
      assessment = "insufficient-evidence";
      evidenceGate = "downgraded-incomplete-causal-evidence";
    } else if (assessment === "contract-backed-conflict" && (
      !contract.identity || !contract.providerChange || !contract.consumerDependency || !contract.composedFailure
      || contract.providerSide === "unknown" || contract.consumerSide === "unknown"
      || contract.providerSide === contract.consumerSide
    )) {
      assessment = "testable-hypothesis";
      evidenceGate = "downgraded-incomplete-contract-trace";
    }
    const verdict = assessment === "contract-backed-conflict" ? "conflict"
      : assessment === "no-plausible-interaction" ? "independent" : "review";
    const interactionHypothesis = {
      status: assessment,
      assumptionOwner: ["PR-A", "PR-B", "both"].includes(raw.assumptionOwner) ? raw.assumptionOwner : "unknown",
      assumption,
      violatingChange,
      preconditions: stringList(raw.preconditions),
      triggerSequence,
      expectedBehavior,
      possibleActualBehavior,
      testPlan,
      contract,
    };
    return [{
      ...comparison,
      id: crypto.randomUUID(),
      verdict,
      relationship: assessment === "contract-backed-conflict" ? "semantic-conflict"
        : assessment === "testable-hypothesis" ? "review-required"
        : assessment === "no-plausible-interaction" ? "no-plausible-interaction"
          : assessment,
      category: raw.category || comparison.category || "code",
      title: raw.title || (assessment === "contract-backed-conflict" ? "코드 계약으로 뒷받침된 semantic conflict"
        : assessment === "testable-hypothesis" ? "실행으로 검증할 상호작용 가설" : comparison.title),
      summary: raw.summary || raw.explanation || comparison.summary,
      assumptionA: raw.assumptionA || (interactionHypothesis.assumptionOwner === "PR-A" ? assumption : ""),
      assumptionB: raw.assumptionB || (interactionHypothesis.assumptionOwner === "PR-B" ? assumption : ""),
      consequence: possibleActualBehavior || comparison.consequence,
      recommendation: assessment === "contract-backed-conflict"
        ? "양쪽 코드 계약이 충돌합니다. 병합 전에 provider 또는 consumer를 같은 계약으로 맞추고, 필요하면 targeted 실행으로 최고 증거 등급까지 승격하세요."
        : assessment === "testable-hypothesis"
        ? `Base/A/B/A+B에서 '${testPlan.name || "제안된 상호작용 테스트"}'를 실행해 가설을 검증하세요.`
        : raw.recommendation || comparison.recommendation,
      evidence: evidenceObjects.map((item) => `${item.side} ${item.file}${item.symbol ? ` (${item.symbol})` : ""}: ${item.quote}`),
      evidenceObjects,
      evidenceGate,
      rawAssessment,
      interactionHypothesis,
      evidenceGrade: assessment === "contract-backed-conflict" ? "contract-backed" : "adjudicated",
      confirmationStatus: assessment === "contract-backed-conflict" ? "contract-backed-static" : "unverified-static-candidate",
      runtimeVerification: "not-run",
      confidence: typeof raw.confidence === "number" ? raw.confidence : null,
      basis,
      source,
    }];
  });
}

const assessmentRisk = {
  "contract-backed-conflict": 0,
  "testable-hypothesis": 1,
  "coordination-required": 2,
  "insufficient-evidence": 3,
  "no-plausible-interaction": 4,
};

export function aggregateSemanticJudgmentRuns(prepared, candidates, protocolRuns, options = {}) {
  const repeats = Math.max(1, Number(protocolRuns?.repeats) || semanticJudgeRepeatCount(options));
  const runs = Array.isArray(protocolRuns?.runs) ? protocolRuns.runs : [];
  const normalizedRuns = runs.map((rawJudgments) => normalizeSemanticJudgments(
    prepared,
    candidates,
    (rawJudgments || []).filter((raw) => raw && !raw.protocolError),
    options,
  ));
  const rawByRun = runs.map((rawJudgments) => new Map((rawJudgments || [])
    .filter((raw) => Array.isArray(raw?.prIds) && raw.prIds.length === 2)
    .map((raw) => [pairKey(raw.prIds), raw])));
  const normalizedByRun = normalizedRuns.map((judgments) => new Map(judgments.map((item) => [item.key, item])));

  return candidates.map((comparison) => {
    const judgments = normalizedByRun.map((run) => run.get(comparison.key) || null);
    const rawEntries = rawByRun.map((run) => run.get(comparison.key) || null);
    const completed = judgments.filter(Boolean);
    const assessments = judgments.map((item) => item?.interactionHypothesis?.status || "missing");
    const rawAssessments = rawEntries.map((raw) => raw?.protocolError ? "error" : raw ? mappedAssessment(raw) : "missing");
    const verdicts = judgments.map((item) => item?.verdict || "missing");
    const uniqueAssessments = uniq(assessments.filter((item) => item !== "missing"));
    const stable = completed.length === repeats && uniqueAssessments.length === 1;
    const representative = [...completed].sort((left, right) =>
      (assessmentRisk[left.interactionHypothesis?.status] ?? 9) - (assessmentRisk[right.interactionHypothesis?.status] ?? 9))[0];
    const protocol = {
      version: AI_JUDGMENT_PROTOCOL_VERSION,
      requestedRepeats: repeats,
      completedRepeats: completed.length,
      failedRepeats: repeats - completed.length,
      rawAssessments,
      assessments,
      verdicts,
      stable,
      consensusAssessment: stable ? uniqueAssessments[0] : null,
      finalTriage: stable ? representative?.verdict || "review" : "needs-review",
    };

    if (stable && representative) return {
      ...representative,
      aiProtocol: protocol,
      aiStability: "stable",
      aiVerdicts: verdicts,
      aiAssessments: assessments,
    };

    const fallback = representative || comparison;
    const observed = assessments.filter((item) => item !== "missing");
    const failureNote = completed.length < repeats ? `; ${repeats - completed.length}회 호출 실패 또는 누락` : "";
    return {
      ...fallback,
      id: crypto.randomUUID(),
      verdict: "review",
      relationship: "review-required",
      title: "AI 반복 판정이 일치하지 않아 사람 검토 필요",
      summary: `동일 입력 ${repeats}회 판정 결과가 전원 일치하지 않았습니다: ${observed.join(" / ") || "유효 판정 없음"}${failureNote}`,
      recommendation: "자동 conflict 또는 independent로 확정하지 말고 입력 증거를 확인하거나 Base/A/B/A+B 실행으로 검증하세요.",
      confirmationStatus: "unstable-ai-candidate",
      runtimeVerification: "not-run",
      evidenceGrade: "adjudicated",
      interactionHypothesis: {
        ...(representative?.interactionHypothesis || {}),
        status: "unstable-ai-judgment",
      },
      aiProtocol: protocol,
      aiStability: "unstable",
      aiVerdicts: verdicts,
      aiAssessments: assessments,
      basis: options.basis || "ai-semantic-judgment",
      source: options.source || "ai",
    };
  });
}
