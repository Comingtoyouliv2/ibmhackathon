import crypto from "node:crypto";
import { buildScirChangeSet } from "./adapters/registry.mjs";

const CATEGORY_LABELS = {
  api: "API 계약", data: "데이터 모델", config: "설정·플래그", auth: "인증·권한",
  event: "이벤트·비동기", rollout: "배포·호환성", behavior: "동작 의미", code: "코드 선언",
};

const CONTROL_WORDS = new Set(["if", "for", "while", "switch", "catch", "return", "throw", "new", "super", "this", "assert", "expect", "when", "then"]);
const TOKEN_STOP = new Set([
  "true", "false", "null", "undefined", "public", "private", "protected", "static", "final", "return",
  "class", "interface", "function", "const", "string", "number", "boolean", "object", "void", "throws",
  "import", "export", "package", "extends", "implements", "async", "await", "this", "super", "test",
  "should", "would", "could", "from", "with", "that", "then", "when", "where", "which", "while",
]);

const CAUSAL_ROLE_BY_TYPE = Object.freeze({
  "delete-vs-modify": "composition-risk",
  "add-vs-add": "composition-risk",
  "competing-replacement": "composition-risk",
  "shared-contract": "composition-risk",
  "schema-vs-access": "dependency",
  "event-producer-consumer": "dependency",
  "same-declaration": "relevance",
  "overlapping-base-region": "relevance",
  "same-file-only": "proximity",
});

const PROOF_ROLES = new Set(["contradiction", "dependency", "composition-risk"]);

const uniq = (values) => [...new Set(values.filter(Boolean))];
const intersect = (a, b) => { const set = new Set(b); return uniq(a.filter((value) => set.has(value))); };
const clean = (value) => value?.replace(/["'`),;\]}]+$/g, "").slice(0, 160);
const pairKey = (ids) => [...ids].sort().join(":");

function normalizeLine(line) {
  return line.trim().replace(/\s+/g, " ");
}

function identifiers(text) {
  return uniq((text.match(/[A-Za-z_$][\w$]{3,}/g) || [])
    .filter((token) => !TOKEN_STOP.has(token.toLowerCase())));
}

function declaration(line) {
  const text = line.trim();
  const typeDeclaration = text.match(/^(?:(?:export|public|private|protected|internal|abstract|final)\s+)*(?:class|interface|enum|struct|record|trait)\s+([A-Za-z_$][\w$]*)(?=\s*(?:[({:]|extends\b|implements\b|$))/);
  if (typeDeclaration) return { name: typeDeclaration[1], signature: normalizeLine(text), kind: "type", arity: null, identity: `type:${typeDeclaration[1]}` };
  const typeAlias = text.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)(?=\s*(?:<|=|$))/);
  if (typeAlias) return { name: typeAlias[1], signature: normalizeLine(text), kind: "type", arity: null, identity: `type:${typeAlias[1]}` };
  const namedFunction = text.match(/^(?:(?:export|public|private|protected|internal|static|final|async)\s+)*(?:def|func|function)\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (namedFunction) {
    const arity = parameterArity(text, text.indexOf("("));
    return { name: namedFunction[1], signature: normalizeLine(text), kind: "callable", arity, identity: `callable:${namedFunction[1]}/${arity ?? "?"}` };
  }
  const callable = text.match(/^(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|override|virtual|async|export)\s+)*(?:[\w$<>,.?\[\]:]+\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:\{|=>|throws|$)/);
  if (callable && !CONTROL_WORDS.has(callable[1])) {
    const arity = parameterArity(text, text.indexOf("(", text.indexOf(callable[1]) + callable[1].length));
    return { name: callable[1], signature: normalizeLine(text), kind: "callable", arity, identity: `callable:${callable[1]}/${arity ?? "?"}` };
  }
  const field = text.match(/^(?:(?:public|private|protected|internal|static|final|volatile|transient|readonly|const)\s+)+[\w$<>,.?\[\]:]+\s+([A-Za-z_$][\w$]*)\s*(?:=|;)/);
  if (field) return { name: field[1], signature: normalizeLine(text), kind: "field", arity: null, identity: `field:${field[1]}` };
  return null;
}

function matchingParen(text, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index;
  }
  return -1;
}

function parameterArity(text, openIndex) {
  if (openIndex < 0) return null;
  const closeIndex = matchingParen(text, openIndex);
  if (closeIndex < 0) return null;
  const body = text.slice(openIndex + 1, closeIndex).trim();
  if (!body) return 0;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let commas = 0;
  for (const char of body) {
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if ("([{<".includes(char)) depth += 1;
    else if (")]}>".includes(char)) depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) commas += 1;
  }
  return commas + 1;
}

function invocations(text) {
  const result = [];
  const regex = /\b(new\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of text.matchAll(regex)) {
    const name = match[2];
    if (CONTROL_WORDS.has(name) || ["class", "interface", "enum", "record"].includes(name)) continue;
    const openIndex = match.index + match[0].lastIndexOf("(");
    const closeIndex = matchingParen(text, openIndex);
    if (closeIndex < 0) continue;
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const prefix = text.slice(lineStart, match.index).trim();
    const suffix = text.slice(closeIndex + 1).match(/^\s*([^\s]*)/)?.[1] || "";
    if (!match[1] && /^(?:export\s+)?(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|override|virtual|async)\s+)*(?:[\w$<>,.?\[\]:]+\s+)+$/.test(prefix) && (suffix.startsWith("{") || suffix.startsWith("throws"))) continue;
    const arity = parameterArity(text, openIndex);
    result.push({ name, arity, identity: `${name}/${arity ?? "?"}`, constructor: Boolean(match[1]) });
  }
  return result;
}

function subtractInvocations(added, removed) {
  const remaining = new Map();
  for (const item of removed) remaining.set(item.identity, (remaining.get(item.identity) || 0) + 1);
  return added.filter((item) => {
    const count = remaining.get(item.identity) || 0;
    if (!count) return true;
    remaining.set(item.identity, count - 1);
    return false;
  });
}

function sectionDeclaration(section = "") {
  const direct = declaration(section.replace(/^.*@@\s*/, "").trim());
  if (direct) return direct.name;
  const match = section.match(/([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*$/);
  return match && !CONTROL_WORDS.has(match[1]) ? match[1] : null;
}

function lineSignals(line) {
  const result = { api: [], env: [], tables: [], fields: [], events: [], flags: [], auth: [] };
  const collect = (key, regex, group = 1) => result[key].push(...[...line.matchAll(regex)].map((match) => clean(match[group])));
  collect("api", /(?:app|router|route)\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)/gi);
  collect("api", /(?:fetch|axios\.(?:get|post|put|patch|delete))\s*\(\s*["'`]([^"'`]+)/gi);
  collect("env", /(?:process\.env\.|import\.meta\.env\.|System\.getenv\s*\(\s*["'])([A-Z][A-Z0-9_]{2,})/g);
  collect("tables", /\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+["'`]?([a-zA-Z_][\w.]*)/g);
  collect("fields", /(?:addColumn|dropColumn|renameColumn)\s*\([^,]+,\s*["'`]([\w.-]+)/gi);
  collect("events", /(?:emit|publish|subscribe|consume)\s*\(\s*["'`]([\w.:-]+)/gi);
  collect("events", /(?:topic|queue|eventName)\s*[:=]\s*["'`]([\w.:-]+)/gi);
  collect("flags", /(?:featureFlag|isEnabled|toggle)\s*\(\s*["'`]([\w.-]+)/gi);
  if (/\b(auth|permission|role|scope|jwt|session|token)\b/i.test(line)) result.auth.push("authorization-boundary");
  for (const key of Object.keys(result)) result[key] = uniq(result[key]);
  return result;
}

function parseHunks(patch = "") {
  const lines = patch.split("\n");
  const hunks = [];
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    const header = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);
    if (header) {
      hunk = {
        oldStart: Number(header[1]), oldCount: Number(header[2] || 1),
        newStart: Number(header[3]), newCount: Number(header[4] || 1),
        section: header[5].trim(), changes: [],
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      hunks.push(hunk);
      continue;
    }
    if (!hunk || line.startsWith("diff --git") || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) { hunk.changes.push({ kind: "add", text: line.slice(1), newLine, oldAnchor: hunk.oldStart }); newLine += 1; }
    else if (line.startsWith("-")) { hunk.changes.push({ kind: "remove", text: line.slice(1), oldLine, oldAnchor: hunk.oldStart }); oldLine += 1; }
    else if (line.startsWith(" ")) {
      hunk.changes.push({ kind: "context", text: line.slice(1), oldLine, newLine, oldAnchor: hunk.oldStart });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks;
}

function projectedHunkChanges(hunk, side) {
  const changedKind = side === "new" ? "add" : "remove";
  return hunk.changes.filter((change) => change.kind === "context" || change.kind === changedKind);
}

function projectedHunkText(hunk, side) {
  return projectedHunkChanges(hunk, side).map((change) => change.text).join("\n");
}

function mayStartDeclaration(line) {
  const text = line.trim();
  if (!text) return false;
  if (/^(?:(?:export|public|private|protected|internal|abstract|final)\s+)*(?:class|interface|enum|struct|record|trait)\b/.test(text)) return true;
  if (/^(?:export\s+)?type\s+[A-Za-z_$][\w$]*/.test(text)) return true;
  if (/^(?:(?:export|public|private|protected|internal|static|final|async)\s+)*(?:def|func|function)\b/.test(text)) return true;
  if (/^(?:(?:public|private|protected|internal|static|final|volatile|transient|readonly|const)\s+)+[\w$<>,.?\[\]:]+\s+[A-Za-z_$][\w$]*\s*(?:=|;)/.test(text)) return true;
  return text.includes("(") && /^(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|override|virtual|async|export)\s+)*(?:[\w$<>,.?\[\]:]+\s+)?[A-Za-z_$][\w$]*\s*\(/.test(text);
}

function declarationsFromHunks(hunks, side, requireSideChange = true) {
  const changedKind = side === "new" ? "add" : "remove";
  const results = [];
  const seen = new Set();
  for (const hunk of hunks) {
    const lines = projectedHunkChanges(hunk, side);
    for (let start = 0; start < lines.length; start += 1) {
      if (!mayStartDeclaration(lines[start].text)) continue;
      let source = "";
      let containsChange = false;
      for (let end = start; end < Math.min(lines.length, start + 16); end += 1) {
        source += `${source ? "\n" : ""}${lines[end].text}`;
        containsChange ||= lines[end].kind === changedKind;
        const parsed = declaration(source);
        if (!parsed) continue;
        if (containsChange || !requireSideChange) {
          const location = side === "new" ? lines[start].newLine : lines[start].oldLine;
          const key = `${parsed.identity}:${hunk.oldStart}:${location ?? start}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({
              ...parsed,
              ...(side === "new" ? { newLine: location } : { oldLine: location }),
              oldAnchor: hunk.oldStart,
            });
          }
        }
        break;
      }
    }
  }
  return results;
}

function memberAccesses(lines) {
  return uniq(lines.flatMap((line) => [...line.matchAll(/\.\s*([A-Za-z_$][\w$]*)\b/g)].map((match) => match[1])));
}

function eventShapes(lines) {
  const shapes = [];
  for (const line of lines) {
    const match = line.match(/\b(emit|publish|subscribe|consume)\s*\(\s*["'`]([\w.:-]+)["'`]([\s\S]*)/i);
    if (!match) continue;
    const object = match[3].match(/\{([^}]*)\}/)?.[1] || "";
    shapes.push({
      name: match[2], role: /^(emit|publish)$/i.test(match[1]) ? "producer" : "consumer",
      fields: identifiers(object).filter((token) => !["async", "await"].includes(token)),
    });
  }
  return shapes;
}

function structuralTables(lines) {
  return uniq(lines.flatMap((line) => [...line.matchAll(/\b(?:ALTER|CREATE|DROP)\s+TABLE\s+["'`]?([A-Za-z_][\w.]*)/gi)].map((match) => match[1])));
}

function configValues(lines) {
  const values = [];
  for (const line of lines) {
    const names = lineSignals(line);
    for (const name of [...names.env, ...names.flags]) {
      const match = line.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^=]*(?:===|==|=|:)\\s*["']?([A-Za-z0-9_.-]+)`, "i"));
      if (match) values.push({ name, value: match[1] });
    }
  }
  return values;
}

function modelFile(file) {
  const hunks = parseHunks(file.patch || "");
  const added = hunks.flatMap((hunk) => hunk.changes.filter((change) => change.kind === "add"));
  const removed = hunks.flatMap((hunk) => hunk.changes.filter((change) => change.kind === "remove"));
  const addedDeclarations = declarationsFromHunks(hunks, "new");
  const removedDeclarations = declarationsFromHunks(hunks, "old");
  const newSignatureDeclarations = declarationsFromHunks(hunks, "new", false);
  const oldSignatureDeclarations = declarationsFromHunks(hunks, "old", false);
  const sections = hunks.map((hunk) => sectionDeclaration(hunk.section)).filter(Boolean);
  const codeFile = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|kts|mjs|php|py|rb|rs|scala|swift|ts|tsx)$/i.test(file.filename);
  const codeLines = (changes) => codeFile ? changes.map((change) => change.text).filter((line) => !/^\s*(?:\/\/|#|\*|\/\*)/.test(line)) : [];
  const addedCodeLines = codeLines(added);
  const removedCodeLines = codeLines(removed);
  const referenceLines = (lines) => lines.filter((line) => !/^\s*(?:import|package)\b/.test(line));
  const codeAddedIdentifiers = identifiers(referenceLines(addedCodeLines).join("\n"));
  const codeRemovedIdentifiers = identifiers(referenceLines(removedCodeLines).join("\n"));
  const signals = {};
  for (const kind of ["added", "removed"]) {
    const changes = kind === "added" ? added : removed;
    signals[kind] = { api: [], env: [], tables: [], fields: [], events: [], flags: [], auth: [] };
    for (const change of changes) {
      const extracted = lineSignals(change.text);
      for (const key of Object.keys(extracted)) signals[kind][key].push(...extracted[key]);
    }
    for (const key of Object.keys(signals[kind])) signals[kind][key] = uniq(signals[kind][key]);
  }
  return {
    filename: file.filename, previousFilename: file.previousFilename, status: file.status || "modified", url: file.url,
    hunks, addedLines: added.map((change) => change.text), removedLines: removed.map((change) => change.text),
    addedDeclarations, removedDeclarations, newSignatureDeclarations, oldSignatureDeclarations,
    addedInvocations: hunks.flatMap((hunk) => subtractInvocations(invocations(projectedHunkText(hunk, "new")), invocations(projectedHunkText(hunk, "old")))),
    changedDeclarations: uniq([...sections, ...addedDeclarations.map((item) => item.name), ...removedDeclarations.map((item) => item.name)]),
    addedIdentifiers: identifiers(added.map((change) => change.text).join("\n")),
    removedIdentifiers: identifiers(removed.map((change) => change.text).join("\n")),
    codeAddedIdentifiers,
    codeRemovedIdentifiers,
    netAddedIdentifiers: codeAddedIdentifiers.filter((item) => !codeRemovedIdentifiers.includes(item)),
    netAddedMemberAccesses: memberAccesses(referenceLines(addedCodeLines)).filter((item) => !memberAccesses(referenceLines(removedCodeLines)).includes(item)),
    eventShapes: { added: eventShapes(added.map((change) => change.text)), removed: eventShapes(removed.map((change) => change.text)) },
    structuralTables: structuralTables(added.map((change) => change.text)),
    configValues: configValues(added.map((change) => change.text)),
    signals,
  };
}

function signatureChangesForFile(file) {
  const beforeDeclarations = file.oldSignatureDeclarations;
  const afterDeclarations = file.newSignatureDeclarations;
  const usedBefore = new Set();
  const usedAfter = new Set();
  const sameDeclarationGroup = (before, after) => after.name === before.name && after.kind === before.kind
    && after.oldAnchor === before.oldAnchor;
  const distance = (before, after) => Math.abs((before.oldLine ?? 0) - (after.newLine ?? 0));
  const candidates = beforeDeclarations.flatMap((before, beforeIndex) => afterDeclarations
    .map((after, afterIndex) => ({ before, beforeIndex, after, afterIndex }))
    .filter(({ after }) => sameDeclarationGroup(before, after)))
    .sort((left, right) => distance(left.before, left.after) - distance(right.before, right.after)
      || Number(left.before.signature !== left.after.signature) - Number(right.before.signature !== right.after.signature));
  const changes = [];
  for (const candidate of candidates) {
    if (usedBefore.has(candidate.beforeIndex) || usedAfter.has(candidate.afterIndex)) continue;
    usedBefore.add(candidate.beforeIndex);
    usedAfter.add(candidate.afterIndex);
    if (candidate.before.signature === candidate.after.signature) continue;
    changes.push({
      file: file.filename, name: candidate.before.name, kind: candidate.before.kind,
      before: candidate.before, after: candidate.after,
    });
  }
  return changes;
}

function buildChangeModel(pr, adapters = undefined) {
  const files = (pr.files || []).map(modelFile);
  const scir = buildScirChangeSet(pr, files, adapters);
  const renames = scir.operations.filter((operation) => operation.kind === "rename" && operation.metadata.adapterId === "generic-diff-v0.1")
    .map((operation) => ({ from: operation.before, to: operation.after, ...operation.metadata }));
  const aggregate = (polarity, key) => uniq(files.flatMap((file) => file.signals[polarity][key]));
  const signatureChanges = files.flatMap(signatureChangesForFile);
  const addedDeclarationNames = new Set(files.flatMap((file) => file.addedDeclarations.map((item) => item.name)));
  const removedDeclarations = files.flatMap((file) => file.removedDeclarations
    .filter((item) => !addedDeclarationNames.has(item.name))
    .map((item) => ({ ...item, file: file.filename })));
  const removedIdentifiers = new Set(files.flatMap((file) => file.codeRemovedIdentifiers));
  return {
    scir,
    files,
    paths: files.map((file) => file.filename),
    added: Object.fromEntries(["api", "env", "tables", "fields", "events", "flags", "auth"].map((key) => [key, aggregate("added", key)])),
    removed: Object.fromEntries(["api", "env", "tables", "fields", "events", "flags", "auth"].map((key) => [key, aggregate("removed", key)])),
    renames,
    eventShapes: files.flatMap((file) => file.eventShapes.added.map((shape) => ({ ...shape, file: file.filename }))),
    structuralTables: uniq(files.flatMap((file) => file.structuralTables)),
    configValues: files.flatMap((file) => file.configValues),
    signatureChanges,
    addedInvocations: files.flatMap((file) => file.addedInvocations.map((item) => ({ ...item, file: file.filename }))),
    removedDeclarations,
    netAddedIdentifiers: uniq(files.flatMap((file) => file.codeAddedIdentifiers).filter((item) => !removedIdentifiers.has(item))),
  };
}

function rangesOverlap(a, b) {
  const aEnd = a.oldStart + Math.max(a.oldCount, 1) - 1;
  const bEnd = b.oldStart + Math.max(b.oldCount, 1) - 1;
  return a.oldStart <= bEnd && b.oldStart <= aEnd;
}

export function createWitness(type, strength, category, title, explanation, evidence, causalRole = null) {
  return { type, strength, category, title, explanation, evidence: uniq(evidence).slice(0, 8), ...(causalRole ? { causalRole } : {}) };
}

function causalRole(witness) {
  if (witness.causalRole) return witness.causalRole;
  if (witness.strength === "direct") return "contradiction";
  return CAUSAL_ROLE_BY_TYPE[witness.type] || (witness.strength === "proximity" ? "proximity" : "relevance");
}

export function assessCausalProof(witnesses) {
  const annotated = witnesses.map((witness) => ({ ...witness, causalRole: causalRole(witness) }));
  const proofWitnesses = annotated.filter((witness) => PROOF_ROLES.has(witness.causalRole));
  const relevanceWitnesses = annotated.filter((witness) => witness.causalRole === "relevance");
  const proximityWitnesses = annotated.filter((witness) => witness.causalRole === "proximity");
  const contradictionWitnesses = proofWitnesses.filter((witness) => witness.causalRole === "contradiction");
  return {
    policyVersion: "causal-proof-v0.1",
    status: contradictionWitnesses.length ? "contradiction" : proofWitnesses.length ? "supported-interaction" : relevanceWitnesses.length ? "hypothesis-only" : "none",
    hasCausalProof: proofWitnesses.length > 0,
    proofWitnessTypes: uniq(proofWitnesses.map((witness) => witness.type)),
    relevanceWitnessTypes: uniq(relevanceWitnesses.map((witness) => witness.type)),
    proximityWitnessTypes: uniq(proximityWitnesses.map((witness) => witness.type)),
    witnesses: annotated,
  };
}

function compareFiles(a, b, options = {}) {
  const witnesses = [];
  const bByPath = new Map(b.files.map((file) => [file.filename, file]));
  for (const left of a.files) {
    const right = bByPath.get(left.filename);
    if (!right) continue;
    const label = left.filename;
    if ((left.status === "removed" && right.status !== "removed") || (right.status === "removed" && left.status !== "removed")) {
      witnesses.push(createWitness("delete-vs-modify", "semantic", "rollout", `${label} 삭제와 수정이 경쟁함`, "한 PR은 파일을 제거하지만 다른 PR은 같은 파일이 계속 존재한다고 전제합니다. Git mergeability와 의도를 함께 확인해야 합니다.", [label]));
      continue;
    }
    if (left.status === "added" && right.status === "added") {
      witnesses.push(createWitness("add-vs-add", "semantic", "code", `${label}을 양쪽이 추가함`, "두 PR이 같은 경로의 새 파일을 정의합니다. 이는 우선 Git의 기계적 mergeability로 확인할 대상입니다.", [label]));
    }
    const sharedRemoved = intersect(left.removedLines.map(normalizeLine).filter((line) => line.length > 8), right.removedLines.map(normalizeLine).filter((line) => line.length > 8));
    const addedA = left.addedLines.map(normalizeLine).filter(Boolean);
    const addedB = right.addedLines.map(normalizeLine).filter(Boolean);
    if (sharedRemoved.length && addedA.length && addedB.length && intersect(addedA, addedB).length < Math.min(addedA.length, addedB.length)) {
      witnesses.push(createWitness("competing-replacement", "semantic", "behavior", `${label}의 같은 기존 동작을 다르게 교체함`, "두 PR이 동일한 base 라인을 제거하고 서로 다른 구현을 넣습니다. Git이 잡는 텍스트 충돌인지 의미 충돌인지 구분해야 합니다.", [label, ...sharedRemoved.slice(0, 2)]));
    }
    const removedIdentities = new Set([...left.removedDeclarations, ...right.removedDeclarations].map((item) => item.identity));
    const duplicateIdentities = new Set();
    for (const addedLeft of left.addedDeclarations) {
      for (const addedRight of right.addedDeclarations) {
        if (!addedLeft.identity || addedLeft.identity !== addedRight.identity || removedIdentities.has(addedLeft.identity)) continue;
        if (addedLeft.oldAnchor === addedRight.oldAnchor || duplicateIdentities.has(addedLeft.identity)) continue;
        duplicateIdentities.add(addedLeft.identity);
        witnesses.push(createWitness(
          "duplicate-declaration-addition", "direct", "code",
          `${addedLeft.name} 선언이 병합 결과에 중복 추가됨`,
          "두 PR이 base의 서로 다른 위치에 동일한 선언 identity를 새로 추가합니다. 각 변경은 단독으로 유효하지만 clean merge 결과에는 중복 선언이 남습니다.",
          [label, addedLeft.signature, addedRight.signature],
        ));
      }
    }
    const sharedDeclarations = intersect(left.changedDeclarations, right.changedDeclarations);
    for (const name of sharedDeclarations) {
      const sigA = left.addedDeclarations.filter((item) => item.name === name).map((item) => item.signature);
      const sigB = right.addedDeclarations.filter((item) => item.name === name).map((item) => item.signature);
      const removedSigA = left.removedDeclarations.filter((item) => item.name === name).map((item) => item.signature);
      const removedSigB = right.removedDeclarations.filter((item) => item.name === name).map((item) => item.signature);
      if (sigA.length && sigB.length && intersect(removedSigA, removedSigB).length && !intersect(sigA, sigB).length) {
        witnesses.push(createWitness("signature-divergence", "direct", "code", `${name} 선언이 두 방향으로 갈라짐`, "동일 선언에 대해 두 PR이 서로 다른 새 signature를 정의합니다.", [label, ...sigA, ...sigB]));
      } else {
        witnesses.push(createWitness("same-declaration", "semantic", "code", `${name}의 의미를 양쪽이 변경함`, "같은 선언을 수정하지만 텍스트만으로 두 변경의 합성 가능성을 확정할 수 없습니다.", [label, name]));
      }
    }
    if (options.comparableBase && !sharedDeclarations.length && left.hunks.some((one) => right.hunks.some((two) => rangesOverlap(one, two)))) {
      witnesses.push(createWitness("overlapping-base-region", "semantic", "behavior", `${label}의 같은 base 영역을 수정함`, "두 PR의 hunk가 같은 원본 라인 범위에 닿습니다. 실제 의도 결합을 확인해야 합니다.", [label]));
    } else if (!sharedDeclarations.length) {
      witnesses.push(createWitness("same-file-only", "proximity", "code", `${label}을 함께 수정함`, "파일은 같지만 동일 선언이나 계약을 바꾼다는 근거는 없습니다.", [label]));
    }
  }
  return witnesses;
}

function compareContracts(a, b) {
  const witnesses = [];
  const specs = [
    ["api", "api", "API"], ["fields", "data", "데이터 필드"],
    ["events", "event", "이벤트"], ["env", "config", "환경변수"], ["flags", "config", "기능 플래그"],
  ];
  for (const [key, category, label] of specs) {
    const removedA = a.removed[key].filter((value) => !a.added[key].includes(value));
    const removedB = b.removed[key].filter((value) => !b.added[key].includes(value));
    const removedUsedAB = intersect(removedA, b.added[key]);
    const removedUsedBA = intersect(removedB, a.added[key]);
    for (const value of [...removedUsedAB, ...removedUsedBA]) {
      witnesses.push(createWitness("contract-removal-vs-use", "direct", category, `${label} ${value}의 제거와 사용이 충돌함`, "한 PR은 계약을 제거하지만 다른 PR은 같은 계약을 새 코드에서 사용합니다.", [`${label}: ${value}`]));
    }
    for (const value of intersect(a.added[key], b.added[key])) {
      if (key === "events") continue;
      witnesses.push(createWitness("shared-contract", "semantic", category, `${label} ${value}를 양쪽이 정의함`, "같은 계약 표면을 함께 변경합니다. 형식과 기본값이 합치되는지 확인해야 합니다.", [`${label}: ${value}`]));
    }
  }
  for (const table of intersect(a.structuralTables, b.added.tables)) witnesses.push(createWitness("schema-vs-access", "semantic", "data", `스키마 변경과 ${table} 접근이 상호작용함`, "한 PR은 테이블 구조를 바꾸고 다른 PR은 같은 테이블을 새 코드에서 사용합니다.", [`데이터 테이블: ${table}`]));
  for (const table of intersect(b.structuralTables, a.added.tables)) witnesses.push(createWitness("schema-vs-access", "semantic", "data", `스키마 변경과 ${table} 접근이 상호작용함`, "한 PR은 테이블 구조를 바꾸고 다른 PR은 같은 테이블을 새 코드에서 사용합니다.", [`데이터 테이블: ${table}`]));

  for (const producer of a.eventShapes.filter((shape) => shape.role === "producer")) {
    for (const consumer of b.eventShapes.filter((shape) => shape.role === "consumer" && shape.name === producer.name)) {
      const missing = consumer.fields.filter((field) => !producer.fields.includes(field));
      if (missing.length) witnesses.push(createWitness("event-payload-mismatch", "direct", "event", `${producer.name} payload가 consumer 요구를 충족하지 않음`, "새 producer payload에 새 consumer가 읽는 필드가 없습니다.", [producer.file, consumer.file, `누락 필드: ${missing.join(", ")}`]));
      else witnesses.push(createWitness("event-producer-consumer", "semantic", "event", `${producer.name} producer와 consumer가 함께 변경됨`, "payload 필드는 맞지만 의미와 전달 시점의 호환성을 확인해야 합니다.", [producer.file, consumer.file]));
    }
  }
  for (const producer of b.eventShapes.filter((shape) => shape.role === "producer")) {
    for (const consumer of a.eventShapes.filter((shape) => shape.role === "consumer" && shape.name === producer.name)) {
      const missing = consumer.fields.filter((field) => !producer.fields.includes(field));
      if (missing.length) witnesses.push(createWitness("event-payload-mismatch", "direct", "event", `${producer.name} payload가 consumer 요구를 충족하지 않음`, "새 producer payload에 새 consumer가 읽는 필드가 없습니다.", [producer.file, consumer.file, `누락 필드: ${missing.join(", ")}`]));
      else witnesses.push(createWitness("event-producer-consumer", "semantic", "event", `${producer.name} producer와 consumer가 함께 변경됨`, "payload 필드는 맞지만 의미와 전달 시점의 호환성을 확인해야 합니다.", [producer.file, consumer.file]));
    }
  }
  for (const left of a.configValues) for (const right of b.configValues) {
    if (left.name === right.name && left.value !== right.value) witnesses.push(createWitness("config-default-divergence", "direct", "config", `${left.name} 기본값이 서로 다름`, "두 PR이 같은 설정에 서로 다른 값을 정의합니다.", [`${left.name}: ${left.value} ↔ ${right.value}`]));
  }
  const compareRenames = (renamingModel, referenceModel) => {
    const emitted = new Set();
    const renameOperations = renamingModel.scir.operations.filter((operation) => operation.kind === "rename" && operation.metadata.adapterId === "generic-diff-v0.1");
    const references = referenceModel.scir.dependencies.filter((dependency) => dependency.relation === "references" && dependency.status === "added");
    for (const operation of renameOperations) {
      const rename = { from: operation.before, to: operation.after, ...operation.metadata };
      const sameFileReference = references.some((dependency) => dependency.target.name === rename.from && dependency.target.scope === rename.file);
      const memberReference = references.some((dependency) => dependency.target.name === rename.from && dependency.metadata.member);
      const explicitReference = rename.inference === "explicit" && references.some((dependency) => dependency.target.name === rename.from);
      if (!sameFileReference && !memberReference && !explicitReference) continue;
      const key = `${rename.from}:${rename.to}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      witnesses.push(createWitness(
        "rename-vs-old-reference", rename.deterministicEligible ? "direct" : "semantic", "rollout",
        `${rename.from} rename 뒤에도 기존 이름을 사용함`,
        `한 PR은 ${rename.from}을 ${rename.to}로 바꾸지만 다른 PR은 기존 이름을 새 코드에서 참조합니다.`,
        [rename.file, `${rename.from} → ${rename.to}`, ...(rename.evidence || [])],
        rename.deterministicEligible ? "contradiction" : "dependency",
      ));
    }
  };
  compareRenames(a, b);
  compareRenames(b, a);

  const compareImports = (removingModel, usingModel) => {
    const emitted = new Set();
    const removedBindings = removingModel.scir.operations.filter((operation) => operation.kind === "remove"
      && operation.metadata.binding && operation.metadata.simpleName);
    const addedBindings = [...removingModel.scir.operations, ...usingModel.scir.operations].filter((operation) => operation.kind === "add"
      && operation.metadata.binding && operation.metadata.simpleName);
    const requirements = usingModel.scir.dependencies.filter((dependency) => dependency.relation === "requires-binding"
      && dependency.status === "added" && dependency.metadata.binding);
    for (const removedImport of removedBindings) {
      const { file, simpleName, qualified, conflictEligible } = removedImport.metadata;
      if (!conflictEligible) continue;
      const requirement = requirements.find((dependency) => dependency.target.scope === file && dependency.target.name === simpleName);
      const replacementExists = addedBindings.some((operation) => operation.metadata.file === file && operation.metadata.simpleName === simpleName)
        || requirement?.metadata.localType || requirement?.metadata.qualifiedReference;
      if (!requirement || replacementExists) continue;
      const key = `${file}:${simpleName}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      witnesses.push(createWitness(
        "import-removal-vs-new-use", removedImport.metadata.deterministicEligible ? "direct" : "semantic", "api",
        `${simpleName} binding 제거와 새 사용이 충돌함`,
        `한 PR은 ${qualified} binding을 제거하지만 다른 PR은 같은 파일에서 ${simpleName}을 새로 사용하며 대체 binding을 제공하지 않습니다.`,
        [file, `${qualified} binding`, simpleName],
        removedImport.metadata.deterministicEligible ? "contradiction" : "dependency",
      ));
    }
  };
  compareImports(a, b);
  compareImports(b, a);
  const compareSignatureCalls = (changes, calls) => {
    const emitted = new Set();
    for (const change of changes) {
      if (change.kind !== "callable" || change.before.arity === null || change.after.arity === null || change.before.arity === change.after.arity) continue;
      for (const call of calls.filter((item) => item.name === change.name && item.arity === change.before.arity)) {
        const key = `${change.file}:${change.name}:${change.before.arity}:${call.file}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        witnesses.push(createWitness(
          "signature-change-vs-old-call", "direct", "api",
          `${change.name}의 이전 ${change.before.arity}개 인자 호출이 새 signature와 충돌함`,
          `한 PR은 ${change.name}의 인자 수를 ${change.before.arity}개에서 ${change.after.arity}개로 바꾸지만 다른 PR은 이전 형식의 호출을 새로 추가합니다.`,
          [change.file, call.file, change.before.signature, change.after.signature],
        ));
      }
    }
  };
  compareSignatureCalls(a.signatureChanges, b.addedInvocations);
  compareSignatureCalls(b.signatureChanges, a.addedInvocations);

  const compareRemovedSymbols = (removed, references) => {
    for (const declaration of removed) {
      if (declaration.kind !== "type" || !/^[A-Z]/.test(declaration.name)) continue;
      if (!references.includes(declaration.name)) continue;
      witnesses.push(createWitness(
        "removed-symbol-vs-new-reference", "direct", "api",
        `${declaration.name} 제거 뒤 다른 PR이 새 참조를 추가함`,
        "한 PR은 코드 선언을 제거하지만 다른 PR은 그 선언이 계속 존재한다고 전제하는 새 참조를 추가합니다.",
        [declaration.file, declaration.signature, declaration.name],
      ));
    }
  };
  compareRemovedSymbols(a.removedDeclarations, b.netAddedIdentifiers);
  compareRemovedSymbols(b.removedDeclarations, a.netAddedIdentifiers);
  return witnesses;
}

export const DEFAULT_DETECTORS = Object.freeze([
  {
    id: "file-interaction",
    detect: (a, b) => compareFiles(a.changeModel, b.changeModel, {
      comparableBase: (!a.baseSha && !b.baseSha) || (Boolean(a.baseSha) && a.baseSha === b.baseSha),
    }),
  },
  { id: "contract-lifecycle", detect: (a, b) => compareContracts(a.changeModel, b.changeModel) },
]);

function comparePair(a, b, detectors) {
  const strengthRank = { direct: 0, semantic: 1, proximity: 2 };
  const extracted = detectors.flatMap((detector) => detector.detect(a, b) || [])
    .sort((left, right) => strengthRank[left.strength] - strengthRank[right.strength]);
  const { witnesses, ...causalAnalysis } = assessCausalProof(extracted);
  const direct = witnesses.filter((item) => item.strength === "direct");
  const semantic = witnesses.filter((item) => item.strength === "semantic");
  const supportedSemantic = semantic.filter((item) => PROOF_ROLES.has(item.causalRole));
  const hasPatchEvidence = [a, b].every((pr) => pr.changeModel.files.some((file) => file.hunks.length));
  const verdict = direct.length ? "conflict" : supportedSemantic.length ? "review" : hasPatchEvidence ? "independent" : "insufficient";
  const relevanceOnly = verdict === "independent" && causalAnalysis.status === "hypothesis-only";
  const primary = direct[0] || supportedSemantic[0] || semantic[0] || witnesses[0];
  return {
    id: crypto.randomUUID(), key: pairKey([a.id, b.id]), prIds: [a.id, b.id], verdict, witnesses, causalAnalysis,
    category: primary?.category || "code",
    title: relevanceOnly ? "관련 선언은 겹치지만 인과 충돌 증거 없음" : primary?.title || "직접 상호작용 근거 없음",
    summary: relevanceOnly ? "같은 선언을 수정했다는 사실은 관련성 신호일 뿐입니다. 한 변경이 다른 변경의 실패 조건에 도달한다는 dependency·composition·contract 증거가 없어 review 경고로 승격하지 않습니다." : primary?.explanation || "공유 계약이나 동일 선언을 변경한다는 증거를 찾지 못했습니다.",
    assumptionA: `${a.title} 변경이 자신의 diff 밖 계약을 깨지 않는다고 전제합니다.`,
    assumptionB: `${b.title} 변경이 자신의 diff 밖 계약을 깨지 않는다고 전제합니다.`,
    consequence: verdict === "conflict" ? "두 변경을 그대로 합치면 한쪽이 요구하는 계약이나 구현이 사라질 수 있습니다." : verdict === "review" ? "구성 위험이나 방향성 의존성은 확인됐지만 최종 호환 여부는 통합 검증이 필요합니다." : verdict === "insufficient" ? "patch가 없거나 생략되어 두 변경의 상호작용을 판단할 수 없습니다." : relevanceOnly ? "관련성만으로 리뷰 예산을 소모하지 않지만, 아직 호환성을 실행 증명한 것은 아닙니다." : "현재 증거로는 두 변경을 독립적으로 취급할 수 있습니다.",
    recommendation: verdict === "conflict" ? "두 PR을 같은 integration branch에 합쳐 witness가 가리키는 계약을 먼저 통일하세요." : verdict === "review" ? "causal witness가 가리키는 경로를 대상으로 교차 테스트를 추가하고 담당자 확인을 받으세요." : verdict === "insufficient" ? "전체 diff 또는 checkout 기반 분석을 다시 실행하세요." : relevanceOnly ? "낮은 우선순위 근거로만 보존하고, dependency 또는 contract contradiction이 추가로 발견될 때 다시 승격하세요." : "별도의 merge 차단 없이 기존 테스트를 유지하세요.",
    evidence: uniq(witnesses.flatMap((item) => item.evidence)).slice(0, 8),
    basis: direct.length ? "deterministic-witness" : supportedSemantic.length ? "causal-witness" : relevanceOnly ? "relevance-only" : "proximity-only",
    source: "framework",
  };
}

function assumptionsFor(model) {
  const assumptions = [];
  const add = (category, statement, evidence) => assumptions.push({ id: crypto.randomUUID(), category, statement, evidence, confidence: "inferred" });
  if (model.added.api.length || model.removed.api.length) add("api", "변경한 endpoint의 요청·응답 계약이 소비자와 호환된다.", [...model.added.api, ...model.removed.api]);
  if (model.added.tables.length || model.added.fields.length || model.renames.length) add("data", "변경한 데이터 이름과 수명주기를 다른 코드도 동일하게 해석한다.", [...model.added.tables, ...model.added.fields, ...model.renames.map((item) => `${item.from}→${item.to}`)]);
  if (model.added.events.length || model.removed.events.length) add("event", "이벤트 이름과 payload가 producer와 consumer 사이에서 호환된다.", [...model.added.events, ...model.removed.events]);
  if (model.added.env.length || model.added.flags.length) add("config", "설정의 존재 여부와 기본값이 배포 환경에서 일관된다.", [...model.added.env, ...model.added.flags]);
  if (!assumptions.length) add("code", "변경한 선언의 의미가 동시에 열린 다른 PR에서 달라지지 않는다.", model.paths.slice(0, 4));
  return assumptions;
}

export function extractSignals(pr, options = {}) {
  return buildChangeModel(pr, options.adapters);
}

export function prepareAnalysis(prs, options = {}) {
  const detectors = [...DEFAULT_DETECTORS, ...(options.additionalDetectors || [])];
  const normalized = prs.map((pr, index) => {
    const base = {
      id: String(pr.id ?? pr.number ?? index + 1), number: Number(pr.number ?? index + 1),
      title: pr.title || `PR #${pr.number ?? index + 1}`, body: pr.body || "",
      author: pr.author || pr.user?.login || "unknown", url: pr.url || pr.html_url || "#",
      head: pr.head?.ref || pr.head || "feature", base: pr.base?.ref || pr.base || "main",
      headSha: pr.headSha || pr.head?.sha || null, baseSha: pr.baseSha || pr.base?.sha || null,
      updatedAt: pr.updatedAt || pr.updated_at || new Date().toISOString(), additions: pr.additions || 0,
      deletions: pr.deletions || 0, files: pr.files || [],
    };
    base.changeModel = buildChangeModel(base, options.adapters);
    base.assumptions = assumptionsFor(base.changeModel);
    return base;
  });
  const comparisons = [];
  for (let i = 0; i < normalized.length; i += 1) for (let j = i + 1; j < normalized.length; j += 1) comparisons.push(comparePair(normalized[i], normalized[j], detectors));
  const rank = { conflict: 0, review: 1, insufficient: 2, independent: 3 };
  comparisons.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.witnesses.length - a.witnesses.length);
  const candidates = comparisons.filter((item) => item.witnesses.length && item.verdict !== "independent");
  return { prs: normalized, comparisons, candidates };
}

export function finishAnalysis(prepared, aiFindings = []) {
  const aiByPair = new Map(aiFindings.map((item) => [pairKey(item.prIds), item]));
  const resolved = prepared.comparisons.map((comparison) => {
    if (comparison.verdict === "conflict" && comparison.basis === "deterministic-witness") return comparison;
    return aiByPair.get(comparison.key) || comparison;
  });
  const findings = resolved.filter((item) => item.verdict === "conflict" || item.verdict === "coordination" || item.verdict === "review");
  const conflictCount = resolved.filter((item) => item.verdict === "conflict").length;
  const coordinationCount = resolved.filter((item) => item.verdict === "coordination").length;
  const reviewCount = resolved.filter((item) => item.verdict === "review").length;
  const independentCount = resolved.filter((item) => item.verdict === "independent").length;
  const insufficientCount = resolved.filter((item) => item.verdict === "insufficient").length;
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      prCount: prepared.prs.length, pairCount: prepared.comparisons.length,
      candidateCount: prepared.candidates.length, conflictCount, coordinationCount, reviewCount, independentCount, insufficientCount,
      verdict: conflictCount ? "충돌 witness 확인" : coordinationCount ? "Git merge 조율 필요" : reviewCount ? "의미 검토 필요" : "직접 충돌 근거 없음",
    },
    prs: prepared.prs, findings, conflicts: findings, categories: CATEGORY_LABELS,
  };
}

export function analyzeHeuristically(prs, options = {}) {
  return finishAnalysis(prepareAnalysis(prs, options));
}

export function createAnalyzer(options = {}) {
  return {
    prepare: (prs) => prepareAnalysis(prs, options),
    analyze: (prs, aiFindings = []) => finishAnalysis(prepareAnalysis(prs, options), aiFindings),
  };
}
