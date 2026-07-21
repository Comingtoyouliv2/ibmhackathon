import crypto from "node:crypto";

export const SEMANTIC_JUDGE_SYSTEM_PROMPT = `당신은 여러 pull request 사이의 의미적 상호작용을 판정하는 수석 소프트웨어 아키텍트다.
각 PR은 base에서 독립적으로 정상이라고 가정하고, 두 변경을 함께 적용했을 때 한쪽이 새로 요구하는 계약을 다른 쪽이 깨는지만 판정한다.
같은 파일·모듈·심볼을 만진다는 사실은 관련성일 뿐 충돌의 증거가 아니다.
같은 새 파일을 양쪽이 추가해도 내용이 동일하거나 합집합이 그대로 유효하면 compatible이다. add-vs-add 자체를 위험 근거로 쓰지 않는다.
리팩터링과 기능 추가가 함께 보이더라도 한쪽이 제거·변경한 선언이나 상태를 다른 쪽이 실제로 참조·소비하는 방향성 연결이 없으면 compatible이다.
contract-backed-conflict는 실행하지 않았더라도 (1) 한쪽의 실제 provider 계약 변경, (2) 다른 쪽의 실제 consumer 의존, (3) 둘을 합쳤을 때의 결정적인 실패 경로를 양쪽 코드 인용으로 증명할 수 있을 때만 선택한다.
testable-hypothesis는 상호작용 가능성이 있고 구체적인 trigger와 oracle을 제시할 수 있지만 위 세 조건 중 하나라도 코드 증거로 닫히지 않을 때 선택한다.
no-plausible-interaction은 두 변경이 함께 유효한 경우, insufficient-evidence는 저장소 문맥이나 diff가 부족한 경우다.
coordination-required는 기계적 충돌·중복 구현처럼 조율이 필요하지만 silent semantic conflict로 확정할 수 없는 경우다.
contract-backed-conflict는 executable-confirmed와 다르다. 최종 실행 재현 여부는 별도 runtimeVerification 필드로 관리한다.`;

const pairKey = (ids) => [...ids].sort().join(":");
const uniq = (values) => [...new Set(values.filter(Boolean))];

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
    .filter((comparison) => comparison.verdict === "review" && isAdjudicable(comparison))
    .slice(0, primaryLimit);
  const selected = new Set(primary.map((comparison) => comparison.key));
  const eligibleSecondLook = prepared.comparisons
    .filter((comparison) => comparison.verdict === "independent" && isAdjudicable(comparison))
    .filter((comparison) => (comparison.retrievalScore || 0) > 0)
    .filter((comparison) => (comparison.retrievalFeatures?.priority ?? 3) <= 2)
    .filter((comparison) => !selected.has(comparison.key));
  // Exact-file proximity otherwise consumes the entire second-look budget.
  // Reserve a small lane for strong contracts that cross module boundaries,
  // such as a Python client and Java server sharing a normalized HTTP route.
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
  for (const files of Object.values(comparison.retrievalFeatures?.contractFiles || {})) {
    for (const filename of [...(files.left || []), ...(files.right || [])]) paths.add(filename);
  }
  const modules = (comparison.retrievalFeatures?.sharedModules || []).map(modulePrefix).filter(Boolean);
  const symbols = (comparison.retrievalFeatures?.sharedSymbols || []).map(symbolName).filter(Boolean);
  const allFiles = [...(left.files || []), ...(right.files || [])];
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

const FOCUS_TERM_STOP = new Set([
  "api", "http", "https", "event", "config", "schema", "symbol", "file", "module",
  "get", "post", "put", "patch", "delete", "head", "options", "param", "params",
]);

function evidenceTerms(resources = []) {
  return uniq(resources.flatMap((resource) => String(resource).toLowerCase().match(/[a-z_$][a-z0-9_$-]{2,}/g) || [])
    .filter((term) => !FOCUS_TERM_STOP.has(term)))
    .sort((left, right) => right.length - left.length);
}

function contractResourcesForFile(comparison, side, filename) {
  return Object.entries(comparison.retrievalFeatures?.contractFiles || {}).flatMap(([resource, files]) => (
    (files[side] || []).includes(filename) ? [resource] : []
  ));
}

function patchPreamble(lines) {
  const hunkIndex = lines.findIndex((line) => line.startsWith("@@"));
  return lines.slice(0, hunkIndex < 0 ? Math.min(lines.length, 8) : hunkIndex);
}

function enclosingHunkHeader(lines, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) if (lines[cursor].startsWith("@@")) return lines[cursor];
  return null;
}

/**
 * Keeps evidence-bearing windows from anywhere in a long patch. The query is
 * derived from shared contract identities, so this works for HTTP routes,
 * events, config, schemas, and symbols without repository-specific names.
 */
function compactPatch(patch = "", resources = [], maxPatchChars = 9_000) {
  if (patch.length <= maxPatchChars) return patch;
  const terms = evidenceTerms(resources);
  if (!terms.length) return patch.slice(0, maxPatchChars);
  const lines = patch.split("\n");
  const hits = lines.flatMap((line, index) => {
    const lower = line.toLowerCase();
    const matched = terms.filter((term) => lower.includes(term));
    return matched.length ? [{ index, score: matched.length * 100 + matched.reduce((sum, term) => sum + term.length, 0) }] : [];
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  if (!hits.length) return patch.slice(0, maxPatchChars);

  const snippets = [];
  const covered = [];
  const preamble = patchPreamble(lines).join("\n");
  let used = preamble.length;
  for (const hit of hits) {
    if (covered.some(([start, end]) => hit.index >= start && hit.index <= end)) continue;
    const start = Math.max(0, hit.index - 12);
    const end = Math.min(lines.length - 1, hit.index + 12);
    let selectedStart = start;
    let selectedEnd = end;
    const header = enclosingHunkHeader(lines, hit.index);
    const body = lines.slice(start, end + 1);
    if (header && !body.includes(header)) body.unshift(header);
    let snippet = body.join("\n");
    const separator = snippets.length || preamble ? "\n... [unrelated patch content omitted] ...\n" : "";
    if (used + separator.length + snippet.length > maxPatchChars) {
      const compactStart = Math.max(0, hit.index - 4);
      const compactEnd = Math.min(lines.length - 1, hit.index + 4);
      selectedStart = compactStart;
      selectedEnd = compactEnd;
      const compactBody = lines.slice(compactStart, compactEnd + 1);
      if (header && !compactBody.includes(header)) compactBody.unshift(header);
      snippet = compactBody.join("\n");
    }
    if (used + separator.length + snippet.length > maxPatchChars) continue;
    snippets.push(`${separator}${snippet}`);
    covered.push([selectedStart, selectedEnd]);
    used += separator.length + snippet.length;
  }
  if (!snippets.length) return patch.slice(0, maxPatchChars);
  return `${preamble}${snippets.join("")}`.slice(0, maxPatchChars);
}

function compactPr(pr, paths, maxPatchChars, comparison, side) {
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
      patch: compactPatch(file.patch || "", contractResourcesForFile(comparison, side, file.filename), maxPatchChars),
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
      prs: [
        compactPr(left, paths, maxPatchChars, comparison, "left"),
        compactPr(right, paths, maxPatchChars, comparison, "right"),
      ],
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
  if (["no-plausible-interaction", "compatible", "independent"].includes(value)) return "no-plausible-interaction";
  if (["coordination-required", "coordination"].includes(value)) return "coordination-required";
  if (["testable-hypothesis", "uncertain", "review"].includes(value)) return "testable-hypothesis";
  return "insufficient-evidence";
}

function stringList(value) {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function normalizedTestPlan(raw = {}) {
  return {
    name: String(raw.name || "").trim(),
    strategy: String(raw.strategy || "").trim(),
    setup: stringList(raw.setup),
    steps: stringList(raw.steps),
    oracle: String(raw.oracle || "").trim(),
    targetTests: stringList(raw.targetTests),
  };
}

function normalizedContract(raw = {}) {
  return {
    identity: String(raw.identity || "").trim(),
    kind: String(raw.kind || "").trim(),
    providerSide: String(raw.providerSide || "unknown").trim(),
    consumerSide: String(raw.consumerSide || "unknown").trim(),
    providerChange: String(raw.providerChange || "").trim(),
    consumerDependency: String(raw.consumerDependency || "").trim(),
    composedFailure: String(raw.composedFailure || "").trim(),
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
    let evidenceGate = "passed";
    const assumption = String(raw.assumption || raw.assumptionA || raw.assumptionB || "").trim();
    const violatingChange = String(raw.violatingChange || raw.failureMechanism || raw.consequence || raw.explanation || "").trim();
    const triggerSequence = stringList(raw.triggerSequence);
    const expectedBehavior = String(raw.expectedBehavior || "").trim();
    const possibleActualBehavior = String(raw.possibleActualBehavior || raw.failureMechanism || raw.consequence || "").trim();
    const testPlan = normalizedTestPlan(raw.testPlan);
    const contract = normalizedContract(raw.contract);
    const causalAssessment = assessment === "testable-hypothesis" || assessment === "contract-backed-conflict";
    if (causalAssessment && (!evidenceSides.has("A") || !evidenceSides.has("B") || !assumption || !violatingChange
      || !triggerSequence.length || !expectedBehavior || !possibleActualBehavior || !testPlan.steps.length || !testPlan.oracle)) {
      assessment = "insufficient-evidence";
      evidenceGate = "downgraded-incomplete-causal-evidence";
    } else if (assessment === "contract-backed-conflict" && (
      !contract.identity || !contract.kind || !contract.providerChange || !contract.consumerDependency || !contract.composedFailure
      || !["PR-A", "PR-B"].includes(contract.providerSide)
      || !["PR-A", "PR-B"].includes(contract.consumerSide)
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
