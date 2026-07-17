import { createDependency, createEntity, createEvidence, createOperation } from "../scir/index.mjs";

const TOKEN_STOP = new Set([
  "true", "false", "null", "undefined", "public", "private", "protected", "static", "final", "return",
  "class", "interface", "function", "const", "string", "number", "boolean", "object", "void", "throws",
  "import", "export", "package", "extends", "implements", "async", "await", "this", "super", "test",
]);
const normalizeLine = (line) => line.trim().replace(/\s+/g, " ");

function explicitRenamePairs(lines) {
  const pairs = [];
  for (const line of lines) {
    let match = line.match(/RENAME\s+COLUMN\s+["'`]?([\w.-]+)["'`]?\s+TO\s+["'`]?([\w.-]+)/i);
    if (match) pairs.push({ from: match[1], to: match[2] });
    match = line.match(/renameColumn\s*\([^,]+,\s*["'`]([\w.-]+)["'`]\s*,\s*["'`]([\w.-]+)/i);
    if (match) pairs.push({ from: match[1], to: match[2] });
    match = line.match(/\brename\s+(?:from\s+)?["'`]?([\w.-]+)["'`]?\s+(?:to|as)\s+["'`]?([\w.-]+)/i);
    if (match) pairs.push({ from: match[1], to: match[2] });
  }
  return pairs.map((pair) => ({ ...pair, inference: "explicit" }));
}

function identifierSkeleton(line) {
  const source = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""').replace(/\/\/.*$/g, "");
  return {
    tokens: source.match(/[A-Za-z_$][\w$]*/g) || [],
    skeleton: source.replace(/[A-Za-z_$][\w$]*/g, "$").replace(/\s+/g, " ").trim(),
  };
}

function singleIdentifierReplacement(beforeLine, afterLine) {
  const before = identifierSkeleton(beforeLine);
  const after = identifierSkeleton(afterLine);
  if (before.skeleton !== after.skeleton || before.tokens.length !== after.tokens.length) return null;
  let replacement = null;
  for (let index = 0; index < before.tokens.length; index += 1) {
    if (before.tokens[index] === after.tokens[index]) continue;
    const candidate = { from: before.tokens[index], to: after.tokens[index] };
    if (replacement && (replacement.from !== candidate.from || replacement.to !== candidate.to)) return null;
    replacement = candidate;
  }
  if (!replacement || replacement.from === replacement.to || replacement.from.length < 4 || replacement.to.length < 4
    || TOKEN_STOP.has(replacement.from.toLowerCase()) || TOKEN_STOP.has(replacement.to.toLowerCase())) return null;
  const escapedFrom = replacement.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedTo = replacement.to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    ...replacement,
    memberInvocation: new RegExp(`\\.\\s*${escapedFrom}\\s*\\(`).test(beforeLine)
      && new RegExp(`\\.\\s*${escapedTo}\\s*\\(`).test(afterLine),
  };
}

function inferredRenamePairs(hunks) {
  const candidates = new Map();
  for (const hunk of hunks) {
    const removed = hunk.changes.filter((change) => change.kind === "remove");
    const added = hunk.changes.filter((change) => change.kind === "add");
    for (const before of removed) {
      const matches = new Set();
      for (const after of added) {
        const replacement = singleIdentifierReplacement(before.text, after.text);
        if (!replacement) continue;
        const key = `${replacement.from}\u0000${replacement.to}`;
        matches.add(key);
        const candidate = candidates.get(key) || { ...replacement, evidence: new Set(), nonInvocationEvidence: new Set() };
        candidate.evidence.add(normalizeLine(before.text));
        if (!replacement.memberInvocation) candidate.nonInvocationEvidence.add(normalizeLine(before.text));
        candidates.set(key, candidate);
      }
      if (matches.size > 1) {
        for (const key of matches) candidates.get(key)?.evidence.delete(normalizeLine(before.text));
      }
    }
  }
  return [...candidates.values()].filter((candidate) => candidate.nonInvocationEvidence.size >= 2).map((candidate) => ({
    from: candidate.from, to: candidate.to, inference: "repeated-identifier-substitution",
    confidence: candidate.evidence.size, evidence: [...candidate.evidence].slice(0, 3),
  }));
}

export const genericAdapter = Object.freeze({
  id: "generic-diff-v0.1",
  supports: () => true,
  extract({ changeSetId, file, fileModel, language }) {
    const entities = [];
    const operations = [];
    const dependencies = [];
    const evidence = [];
    const evidenceFor = (summary, excerpt, line = null) => {
      const item = createEvidence({ changeSetId, adapterId: this.id, path: file.filename, line, summary, excerpt });
      evidence.push(item);
      return item.id;
    };
    const renames = [
      ...explicitRenamePairs(fileModel.addedLines || []),
      ...inferredRenamePairs(fileModel.hunks || []),
    ];
    for (const rename of renames) {
      const item = createEntity({ adapterId: this.id, kind: "symbol", name: rename.from, scope: file.filename, language, metadata: { inferredKind: "identifier" } });
      entities.push(item);
      const evidenceId = evidenceFor(`${rename.from} identifier is changed to ${rename.to}`, rename.evidence?.[0] || `${rename.from} → ${rename.to}`);
      operations.push(createOperation({
        adapterId: this.id, kind: "rename", entityId: item.id, before: rename.from, after: rename.to,
        evidenceIds: [evidenceId], metadata: {
          file: file.filename, language, inference: rename.inference, confidence: rename.confidence || null, evidence: rename.evidence || [],
          deterministicEligible: rename.inference === "explicit" || language === "java",
        },
      }));
    }
    for (const declaration of fileModel.addedDeclarations || []) {
      const entity = createEntity({ adapterId: this.id, kind: declaration.kind === "callable" ? "callable" : declaration.kind, name: declaration.name, scope: file.filename, language, metadata: { identity: declaration.identity } });
      entities.push(entity);
      const evidenceId = evidenceFor(`${declaration.name} declaration is added`, declaration.signature, declaration.newLine || null);
      operations.push(createOperation({ adapterId: this.id, kind: "add", entityId: entity.id, after: declaration.signature, evidenceIds: [evidenceId], metadata: { file: file.filename, arity: declaration.arity } }));
    }
    for (const declaration of fileModel.removedDeclarations || []) {
      const entity = createEntity({ adapterId: this.id, kind: declaration.kind === "callable" ? "callable" : declaration.kind, name: declaration.name, scope: file.filename, language, metadata: { identity: declaration.identity } });
      entities.push(entity);
      const evidenceId = evidenceFor(`${declaration.name} declaration is removed`, declaration.signature, declaration.oldLine || null);
      operations.push(createOperation({ adapterId: this.id, kind: "remove", entityId: entity.id, before: declaration.signature, evidenceIds: [evidenceId], metadata: { file: file.filename, arity: declaration.arity } }));
    }
    for (const name of fileModel.netAddedIdentifiers || []) {
      const evidenceId = evidenceFor(`${name} reference is newly added`, name);
      dependencies.push(createDependency({
        adapterId: this.id, relation: "references", target: { kind: "symbol", name, scope: file.filename }, status: "added",
        evidenceIds: [evidenceId], metadata: { file: file.filename, member: fileModel.netAddedMemberAccesses?.includes(name) || false },
      }));
    }
    for (const call of fileModel.addedInvocations || []) {
      const evidenceId = evidenceFor(`${call.name}/${call.arity ?? "?"} call is newly added`, call.identity);
      dependencies.push(createDependency({
        adapterId: this.id, relation: "calls", target: { kind: "callable", name: call.name, scope: file.filename, arity: call.arity }, status: "added",
        evidenceIds: [evidenceId], metadata: { file: file.filename, constructor: call.constructor },
      }));
    }
    return { adapterId: this.id, language, entities, operations, dependencies, assumptions: [], evidence };
  },
});
