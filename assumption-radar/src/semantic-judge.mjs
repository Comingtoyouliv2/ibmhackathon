import crypto from "node:crypto";

export const SEMANTIC_JUDGE_SYSTEM_PROMPT = `당신은 여러 pull request 사이의 의미적 상호작용을 판정하는 수석 소프트웨어 아키텍트다.
각 PR은 base에서 독립적으로 정상이라고 가정하고, 두 변경을 함께 적용했을 때 한쪽이 새로 요구하는 계약을 다른 쪽이 깨는지만 판정한다.
같은 파일·모듈·심볼을 만진다는 사실은 관련성일 뿐 충돌의 증거가 아니다.
conflict는 A의 구체적 변경과 B의 구체적 변경을 각각 인용하고, 두 변경이 합쳐질 때 발생하는 인과적 실패를 설명할 수 있을 때만 선택한다.
compatible은 함께 적용 가능한 경우, uncertain은 저장소 문맥이나 실행 없이는 결론을 낼 수 없는 경우다.
coordination은 기계적 충돌·중복 구현처럼 조율이 필요하지만 silent semantic conflict로 확정할 수 없는 경우다.`;

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
  const primary = prepared.comparisons
    .filter((comparison) => comparison.verdict === "review" && isAdjudicable(comparison))
    .slice(0, primaryLimit);
  const selected = new Set(primary.map((comparison) => comparison.key));
  const secondLook = prepared.comparisons
    .filter((comparison) => comparison.verdict === "independent" && isAdjudicable(comparison))
    .filter((comparison) => (comparison.retrievalScore || 0) > 0)
    .filter((comparison) => (comparison.retrievalFeatures?.priority ?? 3) <= 2)
    .filter((comparison) => !selected.has(comparison.key))
    .slice(0, secondLookLimit);
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

function mappedVerdict(rawVerdict) {
  if (rawVerdict === "compatible" || rawVerdict === "independent") return "independent";
  if (rawVerdict === "conflict") return "conflict";
  return "review";
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
    let verdict = mappedVerdict(raw.verdict || raw.prediction || raw.decision);
    let evidenceGate = "passed";
    if (verdict === "conflict" && (!evidenceSides.has("A") || !evidenceSides.has("B") || !String(raw.failureMechanism || raw.consequence || raw.explanation || "").trim())) {
      verdict = "review";
      evidenceGate = "downgraded-missing-bilateral-evidence";
    }
    return [{
      ...comparison,
      id: crypto.randomUUID(),
      verdict,
      category: raw.category || comparison.category || "code",
      title: raw.title || (verdict === "conflict" ? "AI가 양측 변경의 인과 충돌을 확인함" : comparison.title),
      summary: raw.summary || raw.explanation || comparison.summary,
      assumptionA: raw.assumptionA || "",
      assumptionB: raw.assumptionB || "",
      consequence: raw.failureMechanism || raw.consequence || raw.explanation || comparison.consequence,
      recommendation: raw.recommendation || comparison.recommendation,
      evidence: evidenceObjects.map((item) => `${item.side} ${item.file}${item.symbol ? ` (${item.symbol})` : ""}: ${item.quote}`),
      evidenceObjects,
      evidenceGate,
      confidence: typeof raw.confidence === "number" ? raw.confidence : null,
      basis,
      source,
    }];
  });
}
