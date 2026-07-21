import { createWitness, prepareAnalysis } from "./analyzer.mjs";

const GENERIC_IDENTIFIERS = new Set([
  "public", "private", "protected", "static", "final", "class", "interface", "return", "this", "super",
  "new", "void", "null", "true", "false", "string", "int", "long", "boolean", "if", "else", "for",
  "while", "try", "catch", "throw", "throws", "override", "import", "package", "value", "values",
  "result", "results", "object", "method", "java", "org", "com", "the", "and", "from", "with",
]);
const COLLECTION_MUTATOR = /^(?:add|addAll|put|putAll|append|insert|remove|removeAll|clear|push|pop|offer|poll|register\w*|unregister\w*)$/;
const LITERAL_PATTERN = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
const PURE_LITERAL_LIST = /^\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')(?:\s*,\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))*\s*,?\s*$/;
const INTENT_STOP = new Set([
  "add", "added", "change", "changed", "changes", "fix", "fixed", "update", "updated", "remove", "removed",
  "support", "use", "using", "with", "from", "into", "when", "where", "this", "that", "test", "tests",
  "feat", "feature", "refactor", "the", "and", "for", "codex", "historical", "parent", "change", "set",
]);
const HTTP_METHOD = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;

const uniq = (values) => [...new Set(values.filter(Boolean))];
const intersection = (left, right) => [...left].filter((value) => right.has(value));

function isCode(line) {
  return Boolean(line) && !/^\s*(?:\/\/|\/\*|\*|\*\/|import\b|package\b|@|[{};,]?$)/.test(line);
}

function isStructuralOnly(line) {
  return /^(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)+(?:[\w<>?,.\[\] ]+\s+)?\w+\s*\([^;{}]*\)\s*(?:throws[^{}]+)?\{?$/.test(line)
    || /^(?:public|private|protected)\s+[A-Z][\w$]*\s*\([^)]*\)\s*\{?$/.test(line);
}

function identifiers(line) {
  return new Set((line.match(/\b[A-Za-z_$][\w$]{2,}\b/g) || [])
    .filter((identifier) => !GENERIC_IDENTIFIERS.has(identifier.toLowerCase())));
}

function propertyName(method, prefix) {
  const raw = method.slice(prefix.length);
  return `${raw.slice(0, 1).toLowerCase()}${raw.slice(1)}`;
}

function changedLines(file) {
  return (file.hunks || []).flatMap((hunk) => hunk.changes
    .filter((change) => change.kind === "add" || change.kind === "remove")
    .map((change) => ({ sign: change.kind === "add" ? "+" : "-", text: change.text.trim(), oldStart: hunk.oldStart })));
}

function effects(file) {
  const behavioral = changedLines(file).filter((line) => isCode(line.text) && !isStructuralOnly(line.text));
  const added = behavioral.filter((line) => line.sign === "+");
  const writes = new Set();
  const reads = new Set();
  const controls = new Set();
  const mutations = new Map();
  const addedLiterals = new Set();
  const removedLiterals = new Set();

  for (const entry of behavioral) {
    const isAdded = entry.sign === "+";
    for (const literal of entry.text.match(LITERAL_PATTERN) || []) {
      (isAdded ? addedLiterals : removedLiterals).add(literal);
    }
    const line = entry.text.replace(LITERAL_PATTERN, "");
    const assignment = line.match(/(?:^|[;{}])\s*(?:[\w<>?,.\[\]]+\s+)?((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*(?:[+\-*/%]?=|\+\+|--)/);
    if (assignment && isAdded) writes.add(assignment[1].replace(/^this\./, ""));
    if (isAdded && /\breturn\b/.test(line)) writes.add("$return");
    if (isAdded && /\bthrow\b/.test(line)) writes.add("$exception");
    if (isAdded && /\b(?:if|switch|while|for)\s*\(|\b(?:return|throw)\b/.test(line)) controls.add(entry.oldStart);

    for (const call of line.matchAll(/(?:(\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\.)?\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const receiver = call[1]?.replace(/^this\./, "") || "this";
      const method = call[2];
      if (/^set[A-Z]/.test(method)) {
        if (isAdded) writes.add(`${receiver}.${propertyName(method, "set")}`);
      } else if (/^get[A-Z]/.test(method)) {
        if (isAdded) reads.add(`${receiver}.${propertyName(method, "get")}`);
      } else if (COLLECTION_MUTATOR.test(method) || method.startsWith("add") || method.startsWith("put")) {
        const key = `${receiver}.${method}`;
        const mutation = mutations.get(key) || { added: 0, removed: 0 };
        if (isAdded) mutation.added += 1;
        else mutation.removed += 1;
        mutations.set(key, mutation);
        if (isAdded) writes.add(`${receiver}.*`);
      }
    }
    if (isAdded) for (const identifier of identifiers(line)) reads.add(identifier);
  }

  return {
    behaviorLines: added.length,
    writes,
    reads,
    controls,
    collectionGrowth: new Set([...mutations].filter(([, counts]) => counts.added > counts.removed).map(([key]) => key)),
    addedLiterals,
    removedLiterals,
    pureLiteralList: added.length > 0 && added.every((line) => PURE_LITERAL_LIST.test(line.text)),
    evidence: added.slice(0, 5).map((line) => line.text),
  };
}

function minimumDistance(left, right) {
  if (!left.size || !right.size) return Number.POSITIVE_INFINITY;
  return Math.min(...[...left].flatMap((a) => [...right].map((b) => Math.abs(a - b))));
}

function interactionReasons(a, b) {
  if (!a.behaviorLines || !b.behaviorLines) return [];
  const sameWrites = intersection(a.writes, b.writes)
    .filter((state) => !state.endsWith(".*") || (a.collectionGrowth.size && b.collectionGrowth.size));
  const sameGrowth = intersection(a.collectionGrowth, b.collectionGrowth);
  const semanticWritesA = new Set([...a.writes].filter((state) => !state.endsWith(".*")));
  const semanticWritesB = new Set([...b.writes].filter((state) => !state.endsWith(".*")));
  const directFlow = uniq([...intersection(semanticWritesA, b.reads), ...intersection(semanticWritesB, a.reads)])
    .filter((state) => state.length > 3 && !state.startsWith("$"));
  const literalGrowthA = [...a.addedLiterals].filter((literal) => !a.removedLiterals.has(literal));
  const literalGrowthB = [...b.addedLiterals].filter((literal) => !b.removedLiterals.has(literal));
  const reasons = [];
  if (sameWrites.length) reasons.push({ kind: "write-write", detail: `같은 상태 쓰기: ${sameWrites.join(", ")}` });
  if (sameGrowth.length) reasons.push({ kind: "collection-growth", detail: `같은 컬렉션 변경: ${sameGrowth.join(", ")}` });
  if (directFlow.length) reasons.push({ kind: "write-read", detail: `한쪽 쓰기와 다른 쪽 읽기: ${directFlow.join(", ")}` });
  if (minimumDistance(a.controls, b.controls) <= 40) reasons.push({ kind: "control-flow", detail: "인접한 제어 흐름을 동시에 수정" });
  if (a.pureLiteralList && b.pureLiteralList && literalGrowthA.length && literalGrowthB.length) {
    reasons.push({ kind: "literal-collection", detail: "같은 리터럴 컬렉션을 동시에 확장" });
  }
  return reasons;
}

export const patchInteractionDetector = Object.freeze({
  id: "patch-effects-v0.1",
  detect(left, right) {
    const rightByPath = new Map(right.changeModel.files.map((file) => [file.filename, file]));
    const witnesses = [];
    for (const leftFile of left.changeModel.files) {
      const rightFile = rightByPath.get(leftFile.filename);
      if (!rightFile) continue;
      const leftEffects = effects(leftFile);
      const rightEffects = effects(rightFile);
      const reasons = interactionReasons(leftEffects, rightEffects);
      if (!reasons.length) continue;
      const strongest = reasons.find((reason) => reason.kind === "write-read") || reasons.find((reason) => reason.kind === "write-write") || reasons[0];
      witnesses.push(createWitness(
        `patch-${strongest.kind}`,
        "semantic",
        "behavior",
        `${leftFile.filename}의 상태·제어 흐름 상호작용`,
        `${reasons.map((reason) => reason.detail).join("; ")}. 실제 충돌 여부는 A+B 실행 또는 문맥 판정이 필요합니다.`,
        [leftFile.filename, ...leftEffects.evidence.map((line) => `A: ${line}`), ...rightEffects.evidence.map((line) => `B: ${line}`)],
        "relevance",
      ));
    }
    return witnesses.slice(0, 3);
  },
});

function pathModule(path = "") {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === "modules" && parts[1]) return `module:${parts[0]}/${parts[1]}`;
  if (["src", "lib", "app", "packages", "crates"].includes(parts[0]) && parts[1]) return `module:${parts[0]}/${parts[1]}`;
  return `module:${parts[0]}`;
}

function intentTokens(text = "") {
  return new Set((text.toLowerCase().match(/[a-z_$][a-z0-9_$-]{2,}/g) || [])
    .filter((token) => !INTENT_STOP.has(token)));
}

function patchSideLines(patch = "", side) {
  return patch.split("\n").flatMap((line) => {
    if (/^(?:diff --git|index |--- |\+\+\+|@@)/.test(line)) return [];
    if (line.startsWith(" ")) return [line.slice(1)];
    if (side === "after" && line.startsWith("+") && !line.startsWith("+++")) return [line.slice(1)];
    if (side === "before" && line.startsWith("-") && !line.startsWith("---")) return [line.slice(1)];
    return [];
  });
}

function httpMethodOnLine(line = "") {
  const upperAnnotation = line.match(/@\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i)?.[1];
  if (upperAnnotation) return upperAnnotation.toUpperCase();
  const mapping = line.match(/@\s*(Get|Post|Put|Patch|Delete)Mapping\b/i)?.[1];
  if (mapping) return mapping.toUpperCase();
  const requestMethod = line.match(/RequestMethod\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i)?.[1];
  if (requestMethod) return requestMethod.toUpperCase();
  const firstArgument = line.match(/(?:_request|request)\s*\(\s*[furb]*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/i)?.[1];
  if (firstArgument) return firstArgument.toUpperCase();
  const methodCall = line.match(/\b(?:app|router|route|client|session|requests?|axios)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(/i)?.[1];
  return methodCall ? methodCall.toUpperCase() : null;
}

function routeStrings(line = "") {
  return [...line.matchAll(/[furb]*(["'`])((?:\\.|(?!\1).)*)\1/g)]
    .map((match) => match[2])
    .filter((value) => value.includes("/") && !/^(?:application|text|image|audio|video)\//i.test(value));
}

function normalizeHttpPath(raw = "") {
  let value = raw.trim()
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/\$\{[^}]+\}|\{[^}]+\}|<[^>]+>|:[A-Za-z_$][\w$]*/g, "{param}")
    .split(/[?#]/, 1)[0]
    .replace(/\\\//g, "/")
    .replace(/\/{2,}/g, "/");
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/$/, "");
  const segments = value.split("/").filter(Boolean);
  if (segments.length < 2 || segments.some((segment) => /\s/.test(segment))) return null;
  return `/${segments.join("/")}`;
}

function routeResourceKeys(method, path) {
  if (!HTTP_METHOD.test(method || "") || !path) return [];
  const segments = path.split("/").filter(Boolean);
  const paths = [path];
  // Server annotations often omit a class-level prefix that clients include.
  // A three-segment suffix is specific enough to join those representations
  // without collapsing every `/resource/{id}` route together.
  if (segments.length > 3) paths.push(`/${segments.slice(-3).join("/")}`);
  return uniq(paths.map((item) => `api:http:${method}:${item}`));
}

function httpContractEntries(pr) {
  const entries = [];
  for (const file of pr.files || []) {
    for (const side of ["before", "after"]) {
      const lines = patchSideLines(file.patch || "", side);
      for (let index = 0; index < lines.length; index += 1) {
        const paths = routeStrings(lines[index]).map(normalizeHttpPath).filter(Boolean);
        if (!paths.length) continue;
        let method = httpMethodOnLine(lines[index]);
        if (!method) {
          for (let distance = 1; distance <= 4 && !method; distance += 1) {
            method = httpMethodOnLine(lines[index - distance]) || httpMethodOnLine(lines[index + distance]);
          }
        }
        for (const path of paths) {
          for (const resource of routeResourceKeys(method, path)) {
            entries.push({ resource, filename: file.filename, side });
          }
        }
      }
    }
  }
  return entries.filter((entry, index, values) => values.findIndex((candidate) => candidate.resource === entry.resource
    && candidate.filename === entry.filename && candidate.side === entry.side) === index);
}

function matchingResourceFiles(model, value) {
  const needle = String(value || "").replace(/^.*?:/, "");
  if (!needle) return [];
  const normalizedNeedle = needle.toLowerCase();
  return model.files.filter((file) => [
    file.filename,
    ...(file.hunks || []).flatMap((hunk) => [hunk.section, ...(hunk.changes || []).map((change) => change.text)]),
  ].some((text) => String(text || "").toLowerCase().includes(normalizedNeedle))).map((file) => file.filename);
}

export function buildContractCard(pr) {
  const model = pr.changeModel;
  const resources = new Set();
  const provenance = new Map();
  const add = (resource, filenames = []) => {
    if (!resource) return;
    resources.add(resource);
    const files = provenance.get(resource) || new Set();
    for (const filename of filenames) if (filename) files.add(filename);
    provenance.set(resource, files);
  };
  for (const file of model.files) {
    add(`file:${file.filename}`, [file.filename]);
    add(pathModule(file.filename), [file.filename]);
  }
  for (const name of [...model.added.api, ...model.removed.api]) add(`api:${name}`, matchingResourceFiles(model, name));
  for (const name of [...model.added.events, ...model.removed.events]) add(`event:${name}`, matchingResourceFiles(model, name));
  for (const name of [...model.added.env, ...model.removed.env, ...model.added.flags, ...model.removed.flags]) add(`config:${name}`, matchingResourceFiles(model, name));
  for (const name of [...model.added.tables, ...model.added.fields, ...model.removed.tables, ...model.removed.fields]) add(`schema:${name}`, matchingResourceFiles(model, name));
  for (const entity of model.scir.entities) {
    if (entity.name?.length >= 4 && !GENERIC_IDENTIFIERS.has(entity.name.toLowerCase())) {
      add(`symbol:${entity.name}`, matchingResourceFiles(model, entity.name));
    }
  }
  for (const entry of httpContractEntries(pr)) add(entry.resource, [entry.filename]);
  return {
    prId: pr.id,
    summary: pr.title,
    resources: [...resources].filter(Boolean).sort(),
    assumptions: pr.assumptions.map((assumption) => assumption.statement),
    intentTokens: [...intentTokens(`${pr.title} ${pr.body}`)].sort(),
    resourceFiles: Object.fromEntries([...provenance].map(([resource, files]) => [resource, [...files].sort()])),
  };
}

function idfMaps(cards) {
  const frequencies = new Map();
  for (const card of cards) for (const resource of card.resources) frequencies.set(resource, (frequencies.get(resource) || 0) + 1);
  return new Map([...frequencies].map(([resource, count]) => [resource, Math.log((cards.length + 1) / (count + 1)) + 1]));
}

export function retrievalFeatures(left, right, idf = new Map()) {
  const leftResources = new Set(left.resources);
  const rightResources = new Set(right.resources);
  const sharedResources = intersection(leftResources, rightResources);
  const sharedFiles = sharedResources.filter((resource) => resource.startsWith("file:"));
  const sharedModules = sharedResources.filter((resource) => resource.startsWith("module:"));
  const sharedContracts = sharedResources.filter((resource) => /^(?:api|event|config|schema|symbol):/.test(resource));
  const leftTokens = new Set(left.intentTokens);
  const rightTokens = new Set(right.intentTokens);
  const sharedIntent = intersection(leftTokens, rightTokens);
  const tokenUnion = new Set([...leftTokens, ...rightTokens]);
  const intentSimilarity = tokenUnion.size ? sharedIntent.length / tokenUnion.size : 0;
  const resourceWeight = sharedContracts.reduce((sum, resource) => sum + (idf.get(resource) || 1), 0);
  const strongContracts = sharedContracts.filter((resource) => !resource.startsWith("symbol:"));
  const sharedSymbols = sharedContracts.filter((resource) => resource.startsWith("symbol:"));
  const priority = sharedFiles.length || strongContracts.length ? 0
    : sharedModules.length ? 1
      : sharedSymbols.length || sharedIntent.length ? 2 : 3;
  const score = sharedFiles.length * 1_000 + sharedModules.length * 500 + strongContracts.length * 250
    + sharedSymbols.reduce((sum, resource) => sum + (idf.get(resource) || 1) * 8, 0)
    + intentSimilarity * 20;
  return {
    score,
    priority,
    sharedFiles,
    sharedModules,
    sharedContracts,
    strongContracts,
    sharedSymbols,
    sharedIntent,
    contractFiles: Object.fromEntries(sharedContracts.map((resource) => [resource, {
      left: left.resourceFiles?.[resource] || [],
      right: right.resourceFiles?.[resource] || [],
    }])),
    reasons: [
      ...sharedFiles.map((value) => `exact-file:${value.slice(5)}`),
      ...sharedModules.map((value) => `module:${value.slice(7)}`),
      ...sharedContracts.map((value) => `resource:${value}`),
      ...(sharedIntent.length ? [`intent:${sharedIntent.slice(0, 6).join(",")}`] : []),
    ],
  };
}

function attachRetrieval(prepared) {
  const cards = prepared.prs.map(buildContractCard);
  const byId = new Map(cards.map((card) => [card.prId, card]));
  const idf = idfMaps(cards);
  const comparisons = prepared.comparisons.map((comparison) => {
    const feature = retrievalFeatures(byId.get(comparison.prIds[0]), byId.get(comparison.prIds[1]), idf);
    const patchInteractionCount = comparison.witnesses.filter((witness) => witness.type.startsWith("patch-")).length;
    return {
      ...comparison,
      retrievalScore: feature.score + patchInteractionCount * 30,
      retrievalReasons: feature.reasons,
      retrievalFeatures: feature,
    };
  });
  return { ...prepared, cards, comparisons };
}

function stablePairOrder(left, right) {
  return left.prIds.join(":").localeCompare(right.prIds.join(":"));
}

export function prepareIntegratedAnalysis(prs, options = {}) {
  const prepared = attachRetrieval(prepareAnalysis(prs, {
    ...options,
    additionalDetectors: [...(options.additionalDetectors || []), patchInteractionDetector],
  }));
  const rank = { conflict: 0, review: 1, insufficient: 2, independent: 3 };
  prepared.comparisons.sort((left, right) => left.retrievalFeatures.priority - right.retrievalFeatures.priority
    || rank[left.verdict] - rank[right.verdict]
    || right.retrievalScore - left.retrievalScore
    || right.witnesses.length - left.witnesses.length
    || stablePairOrder(left, right));
  prepared.candidates = prepared.comparisons.filter((comparison) => comparison.verdict !== "independent" && comparison.witnesses.length);
  return prepared;
}

export function prepareIntentPrototypeAnalysis(prs, options = {}) {
  const prepared = attachRetrieval(prepareAnalysis(prs, options));
  prepared.comparisons = prepared.comparisons.map((comparison) => ({
    ...comparison,
    verdict: comparison.retrievalScore > 0 ? "review" : "independent",
    basis: "intent-resource-retrieval-prototype",
    title: comparison.retrievalScore > 0 ? "Intent/resource가 겹치는 후보" : "공유 Intent/resource 없음",
    summary: comparison.retrievalReasons.join("; ") || "구조화된 Intent/resource 접점을 찾지 못했습니다.",
  })).sort((left, right) => left.retrievalFeatures.priority - right.retrievalFeatures.priority
    || right.retrievalScore - left.retrievalScore || stablePairOrder(left, right));
  prepared.candidates = prepared.comparisons.filter((comparison) => comparison.verdict === "review");
  return prepared;
}
