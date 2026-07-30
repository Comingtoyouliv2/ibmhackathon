import crypto from "node:crypto";
import { buildScirChangeSet } from "./adapters/registry.mjs";

const CATEGORY_LABELS = {
  api: "API contract", data: "Data model", config: "Configuration and flags", auth: "Authentication and authorization",
  event: "Events and async flows", rollout: "Deployment and compatibility", behavior: "Behavior", code: "Code declaration",
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
  "lifecycle-completion-gap": "composition-risk",
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

function memberReceivers(lines) {
  return uniq(lines.flatMap((line) => [...line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\./g)]
    .map((match) => match[1])
    .filter((name) => !["this", "super"].includes(name))));
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
  const addedInvocationSites = hunks.flatMap((hunk) => subtractInvocations(
    invocations(projectedHunkText(hunk, "new")),
    invocations(projectedHunkText(hunk, "old")),
  ).map((invocation) => {
    const hunkAddedCallableNames = declarationsFromHunks([hunk], "new")
      .filter((item) => item.kind === "callable")
      .map((item) => item.name);
    return {
      ...invocation,
      oldStart: hunk.oldStart,
      oldCount: hunk.oldCount,
      section: sectionDeclaration(hunk.section),
      hunkAddedCallableNames,
    };
  }));
  const addedCallableExitLines = hunks.flatMap((hunk) => {
    const addedCallables = declarationsFromHunks([hunk], "new").filter((item) => item.kind === "callable");
    if (!addedCallables.length) return [];
    return hunk.changes.filter((change) => change.kind === "add" && /\breturn\b/.test(change.text)).map((change) => change.text);
  });
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
    addedInvocations: addedInvocationSites,
    addedInvocationSites,
    addedCallableExitLines,
    changedDeclarations: uniq([...sections, ...addedDeclarations.map((item) => item.name), ...removedDeclarations.map((item) => item.name)]),
    addedIdentifiers: identifiers(added.map((change) => change.text).join("\n")),
    removedIdentifiers: identifiers(removed.map((change) => change.text).join("\n")),
    codeAddedIdentifiers,
    codeRemovedIdentifiers,
    netAddedIdentifiers: codeAddedIdentifiers.filter((item) => !codeRemovedIdentifiers.includes(item)),
    netAddedMemberAccesses: memberAccesses(referenceLines(addedCodeLines)).filter((item) => !memberAccesses(referenceLines(removedCodeLines)).includes(item)),
    netAddedMemberReceivers: memberReceivers(referenceLines(addedCodeLines)).filter((item) => !memberReceivers(referenceLines(removedCodeLines)).includes(item)),
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
      witnesses.push(createWitness("delete-vs-modify", "semantic", "rollout", `Deletion and modification compete for ${label}`, "One PR removes the file while the other assumes it still exists. Check both Git mergeability and intent.", [label]));
      continue;
    }
    if (left.status === "added" && right.status === "added") {
      witnesses.push(createWitness("add-vs-add", "semantic", "code", `Both PRs add ${label}`, "Both PRs define a new file at the same path. Git mergeability should be checked first.", [label]));
    }
    const sharedRemoved = intersect(left.removedLines.map(normalizeLine).filter((line) => line.length > 8), right.removedLines.map(normalizeLine).filter((line) => line.length > 8));
    const addedA = left.addedLines.map(normalizeLine).filter(Boolean);
    const addedB = right.addedLines.map(normalizeLine).filter(Boolean);
    if (sharedRemoved.length && addedA.length && addedB.length && intersect(addedA, addedB).length < Math.min(addedA.length, addedB.length)) {
      witnesses.push(createWitness("competing-replacement", "semantic", "behavior", `Both PRs replace the same behavior in ${label} differently`, "Both PRs remove the same base line and introduce different implementations. Determine whether this is a textual Git conflict or a semantic interaction.", [label, ...sharedRemoved.slice(0, 2)]));
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
          `${addedLeft.name} is added twice in the merged result`,
          "Both PRs add the same declaration identity at different base anchors. Each change is valid alone, but a clean merge leaves duplicate declarations.",
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
        witnesses.push(createWitness("signature-divergence", "direct", "code", `${name} diverges into two signatures`, "Both PRs define different new signatures for the same declaration.", [label, ...sigA, ...sigB]));
      } else {
        witnesses.push(createWitness("same-declaration", "semantic", "code", `Both PRs change the meaning of ${name}`, "Both PRs modify the same declaration, but text alone cannot establish whether the changes compose safely.", [label, name]));
      }
    }
    if (options.comparableBase && !sharedDeclarations.length && left.hunks.some((one) => right.hunks.some((two) => rangesOverlap(one, two)))) {
      witnesses.push(createWitness("overlapping-base-region", "semantic", "behavior", `Both PRs modify the same base region in ${label}`, "The hunks touch the same original line range. Their combined intent requires verification.", [label]));
    } else if (!sharedDeclarations.length) {
      witnesses.push(createWitness("same-file-only", "proximity", "code", `Both PRs modify ${label}`, "The file is shared, but there is no evidence that both PRs change the same declaration or contract.", [label]));
    }
  }
  return witnesses;
}

function compareContracts(a, b) {
  const witnesses = [];
  const specs = [
    ["api", "api", "API"], ["fields", "data", "Data field"],
    ["events", "event", "Event"], ["env", "config", "Environment variable"], ["flags", "config", "Feature flag"],
  ];
  for (const [key, category, label] of specs) {
    const removedA = a.removed[key].filter((value) => !a.added[key].includes(value));
    const removedB = b.removed[key].filter((value) => !b.added[key].includes(value));
    const removedUsedAB = intersect(removedA, b.added[key]);
    const removedUsedBA = intersect(removedB, a.added[key]);
    for (const value of [...removedUsedAB, ...removedUsedBA]) {
      witnesses.push(createWitness("contract-removal-vs-use", "direct", category, `Removal and use of ${label} ${value} conflict`, "One PR removes the contract while the other uses that contract in new code.", [`${label}: ${value}`]));
    }
    for (const value of intersect(a.added[key], b.added[key])) {
      if (key === "events") continue;
      witnesses.push(createWitness("shared-contract", "semantic", category, `Both PRs define ${label} ${value}`, "Both PRs change the same contract surface. Verify that formats and defaults remain compatible.", [`${label}: ${value}`]));
    }
  }
  for (const table of intersect(a.structuralTables, b.added.tables)) witnesses.push(createWitness("schema-vs-access", "semantic", "data", `Schema change interacts with access to ${table}`, "One PR changes the table structure while the other uses the same table in new code.", [`Data table: ${table}`]));
  for (const table of intersect(b.structuralTables, a.added.tables)) witnesses.push(createWitness("schema-vs-access", "semantic", "data", `Schema change interacts with access to ${table}`, "One PR changes the table structure while the other uses the same table in new code.", [`Data table: ${table}`]));

  for (const producer of a.eventShapes.filter((shape) => shape.role === "producer")) {
    for (const consumer of b.eventShapes.filter((shape) => shape.role === "consumer" && shape.name === producer.name)) {
      const missing = consumer.fields.filter((field) => !producer.fields.includes(field));
      if (missing.length) witnesses.push(createWitness("event-payload-mismatch", "direct", "event", `${producer.name} payload does not satisfy the consumer`, "The new producer payload omits fields read by the new consumer.", [producer.file, consumer.file, `Missing fields: ${missing.join(", ")}`]));
      else witnesses.push(createWitness("event-producer-consumer", "semantic", "event", `${producer.name} producer and consumer both change`, "The payload fields match, but their meaning and delivery timing still require compatibility verification.", [producer.file, consumer.file]));
    }
  }
  for (const producer of b.eventShapes.filter((shape) => shape.role === "producer")) {
    for (const consumer of a.eventShapes.filter((shape) => shape.role === "consumer" && shape.name === producer.name)) {
      const missing = consumer.fields.filter((field) => !producer.fields.includes(field));
      if (missing.length) witnesses.push(createWitness("event-payload-mismatch", "direct", "event", `${producer.name} payload does not satisfy the consumer`, "The new producer payload omits fields read by the new consumer.", [producer.file, consumer.file, `Missing fields: ${missing.join(", ")}`]));
      else witnesses.push(createWitness("event-producer-consumer", "semantic", "event", `${producer.name} producer and consumer both change`, "The payload fields match, but their meaning and delivery timing still require compatibility verification.", [producer.file, consumer.file]));
    }
  }
  for (const left of a.configValues) for (const right of b.configValues) {
    if (left.name === right.name && left.value !== right.value) witnesses.push(createWitness("config-default-divergence", "direct", "config", `${left.name} has conflicting defaults`, "Both PRs define different values for the same configuration.", [`${left.name}: ${left.value} ↔ ${right.value}`]));
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
        `The old name is still used after renaming ${rename.from}`,
        `One PR renames ${rename.from} to ${rename.to}, while the other references the old name in new code.`,
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
      const replacementExists = addedBindings.some((operation) => operation.metadata.file === file && (
        operation.metadata.simpleName === simpleName
        || (operation.metadata.wildcard
          && Boolean(operation.metadata.static) === Boolean(removedImport.metadata.static)
          && qualified.startsWith(operation.metadata.qualified.slice(0, -1)))
      ))
        || requirement?.metadata.localType || requirement?.metadata.qualifiedReference;
      if (!requirement || replacementExists) continue;
      const key = `${file}:${simpleName}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      witnesses.push(createWitness(
        "import-removal-vs-new-use", removedImport.metadata.deterministicEligible ? "direct" : "semantic", "api",
        `Removal and new use of the ${simpleName} binding conflict`,
        `One PR removes the ${qualified} binding, while the other adds a new use of ${simpleName} in the same file without a replacement binding.`,
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
          `An old ${change.before.arity}-argument call to ${change.name} conflicts with the new signature`,
          `One PR changes ${change.name} from ${change.before.arity} to ${change.after.arity} arguments, while the other adds a call using the old form.`,
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
        `Another PR adds a new reference after ${declaration.name} is removed`,
        "One PR removes a code declaration while the other adds a new reference that assumes the declaration still exists.",
        [declaration.file, declaration.signature, declaration.name],
      ));
    }
  };
  compareRemovedSymbols(a.removedDeclarations, b.netAddedIdentifiers);
  compareRemovedSymbols(b.removedDeclarations, a.netAddedIdentifiers);
  return witnesses;
}

function compareLifecycleCompletion(a, b) {
  const witnesses = [];
  const compareDirection = (pathAddingModel, completionModel) => {
    const completionByPath = new Map(completionModel.files.map((file) => [file.filename, file]));
    for (const pathFile of pathAddingModel.files) {
      const completionFile = completionByPath.get(pathFile.filename);
      if (!completionFile) continue;

      const addedCallableNames = new Set(completionFile.addedDeclarations
        .filter((item) => item.kind === "callable")
        .map((item) => item.name));
      const invocationSites = new Map();
      for (const invocation of completionFile.addedInvocationSites) {
        if (!addedCallableNames.has(invocation.name)) continue;
        if (invocation.oldCount <= 0 || invocation.hunkAddedCallableNames.includes(invocation.name)) continue;
        if (!invocationSites.has(invocation.name)) invocationSites.set(invocation.name, new Set());
        invocationSites.get(invocation.name).add(String(invocation.oldStart));
      }
      const repeatedCompletionCalls = [...invocationSites]
        .filter(([, sites]) => sites.size >= 2)
        .map(([name]) => name);
      if (!repeatedCompletionCalls.length) continue;

      const addsCallablePath = pathFile.addedDeclarations.some((item) => item.kind === "callable");
      const addsExit = pathFile.addedCallableExitLines.length > 0;
      if (!addsCallablePath || !addsExit) continue;

      const sharedStateReceivers = intersect(pathFile.netAddedMemberReceivers, completionFile.netAddedMemberReceivers);
      if (!sharedStateReceivers.length) continue;

      for (const completionName of repeatedCompletionCalls) {
        if (pathFile.addedInvocations.some((item) => item.name === completionName)) continue;
        const completionLines = completionFile.addedLines.filter((line) => line.includes(`${completionName}(`)).slice(0, 2);
        const exitLine = [...pathFile.addedCallableExitLines].sort((left, right) => normalizeLine(left).length - normalizeLine(right).length)[0];
        witnesses.push(createWitness(
          "lifecycle-completion-gap", "semantic", "behavior",
          `A new execution path in ${pathFile.filename} may bypass the ${completionName} completion step`,
          `One PR adds ${completionName} calls to several existing exit paths that operate on the same state (${sharedStateReceivers.join(", ")}), but the new callable exit path introduced by the other PR lacks that call. This is a composition risk until cross-tested.`,
          [pathFile.filename, completionName, ...sharedStateReceivers.slice(0, 3), exitLine, ...completionLines],
          "composition-risk",
        ));
      }
    }
  };
  compareDirection(a, b);
  compareDirection(b, a);
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
  { id: "lifecycle-completion", detect: (a, b) => compareLifecycleCompletion(a.changeModel, b.changeModel) },
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
    title: relevanceOnly ? "Related declarations overlap, but there is no causal conflict evidence" : primary?.title || "No direct interaction evidence",
    summary: relevanceOnly ? "Modifying the same declaration is only a relevance signal. There is no dependency, composition, or contract evidence showing that one change reaches the other's failure condition, so this pair is not escalated to review." : primary?.explanation || "No evidence shows that both PRs change a shared contract or the same declaration.",
    assumptionA: `${a.title} assumes the change does not break contracts outside its own diff.`,
    assumptionB: `${b.title} assumes the change does not break contracts outside its own diff.`,
    consequence: verdict === "conflict" ? "Merging both changes as-is may remove a contract or implementation required by one side." : verdict === "review" ? "A composition risk or directional dependency exists, but integration verification is required to determine compatibility." : verdict === "insufficient" ? "The patch is missing or truncated, so the interaction cannot be judged." : relevanceOnly ? "Relevance alone does not consume review budget, but compatibility has not been proven by execution." : "The current evidence supports treating the changes as independent.",
    recommendation: verdict === "conflict" ? "Merge both PRs on an integration branch and reconcile the contract identified by the witness before merging." : verdict === "review" ? "Add a cross-PR test for the path identified by the causal witness and ask the responsible owner to review it." : verdict === "insufficient" ? "Rerun the analysis with the complete diff or a repository checkout." : relevanceOnly ? "Keep this as low-priority evidence and escalate only if a dependency or contract contradiction is later found." : "Keep existing tests and do not block either merge.",
    evidence: uniq(witnesses.flatMap((item) => item.evidence)).slice(0, 8),
    basis: direct.length ? "deterministic-witness" : supportedSemantic.length ? "causal-witness" : relevanceOnly ? "relevance-only" : "proximity-only",
    source: "framework",
  };
}

function assumptionsFor(model) {
  const assumptions = [];
  const add = (category, statement, evidence) => assumptions.push({ id: crypto.randomUUID(), category, statement, evidence, confidence: "inferred" });
  if (model.added.api.length || model.removed.api.length) add("api", "The changed endpoint's request and response contracts remain compatible with consumers.", [...model.added.api, ...model.removed.api]);
  if (model.added.tables.length || model.added.fields.length || model.renames.length) add("data", "Other code interprets the changed data name and lifecycle consistently.", [...model.added.tables, ...model.added.fields, ...model.renames.map((item) => `${item.from}→${item.to}`)]);
  if (model.added.events.length || model.removed.events.length) add("event", "The event name and payload remain compatible between producer and consumer.", [...model.added.events, ...model.removed.events]);
  if (model.added.env.length || model.added.flags.length) add("config", "The configuration's presence and default value remain consistent in the deployment environment.", [...model.added.env, ...model.added.flags]);
  if (!assumptions.length) add("code", "The meaning of the changed declaration is not altered by another simultaneously open PR.", model.paths.slice(0, 4));
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
    if (comparison.verdict === "conflict" && comparison.basis === "deterministic-witness") {
      const hypothesis = aiByPair.get(comparison.key);
      if (!hypothesis?.interactionHypothesis) return comparison;
      const contractBacked = hypothesis.interactionHypothesis.status === "contract-backed-conflict"
        && hypothesis.evidenceGrade === "contract-backed";
      return {
        ...comparison,
        relationship: contractBacked ? "semantic-conflict" : "review-required",
        confirmationStatus: contractBacked ? "contract-backed-static" : "unverified-static-candidate",
        evidenceGrade: contractBacked ? "contract-backed" : "adjudicated",
        runtimeVerification: "not-run",
        interactionHypothesis: hypothesis.interactionHypothesis,
        hypothesisEvidenceObjects: hypothesis.evidenceObjects || [],
        hypothesisEvidenceGate: hypothesis.evidenceGate,
        hypothesisSource: hypothesis.source,
        hypothesisBasis: hypothesis.basis,
        hypothesisConfidence: hypothesis.confidence,
        aiProtocol: hypothesis.aiProtocol || null,
        aiStability: hypothesis.aiStability || null,
        aiVerdicts: hypothesis.aiVerdicts || [],
        aiAssessments: hypothesis.aiAssessments || [],
      };
    }
    return aiByPair.get(comparison.key) || comparison;
  });
  const classified = resolved.map((item) => item.verdict === "conflict" && !item.confirmationStatus ? {
    ...item,
    confirmationStatus: item.evidenceGrade === "contract-backed" ? "contract-backed-static" : "unverified-static-candidate",
    runtimeVerification: item.runtimeVerification || "not-run",
  } : item);
  const findings = classified.filter((item) => item.verdict === "conflict" || item.verdict === "coordination" || item.verdict === "review");
  const conflictCount = classified.filter((item) => item.verdict === "conflict").length;
  const coordinationCount = classified.filter((item) => item.verdict === "coordination").length;
  const reviewCount = classified.filter((item) => item.verdict === "review").length;
  const independentCount = classified.filter((item) => item.verdict === "independent").length;
  const insufficientCount = classified.filter((item) => item.verdict === "insufficient").length;
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      prCount: prepared.prs.length, pairCount: prepared.comparisons.length,
      candidateCount: prepared.candidates.length, conflictCount, coordinationCount, reviewCount, independentCount, insufficientCount,
      verdict: conflictCount ? "Conflict witness found" : coordinationCount ? "Git merge coordination required" : reviewCount ? "Semantic review required" : "No direct conflict evidence",
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
