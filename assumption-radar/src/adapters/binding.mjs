import { createDependency, createEntity, createEvidence, createOperation } from "../scir/index.mjs";

const LANGUAGE_KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "default", "delete",
  "do", "else", "except", "export", "extends", "false", "finally", "for", "from", "function", "if", "import",
  "in", "interface", "is", "let", "new", "none", "null", "of", "pass", "private", "protected", "public",
  "raise", "return", "static", "super", "switch", "this", "throw", "true", "try", "type", "typeof", "undefined",
  "var", "void", "while", "with", "yield",
]);

function lexicalIdentifiers(lines, importPattern) {
  const names = [];
  for (const line of lines) {
    if (importPattern.test(line)) continue;
    const source = line
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""')
      .replace(/\/\/.*$|#.*$/g, "");
    for (const match of source.matchAll(/(?<!\.)\b[A-Za-z_$][\w$]*\b/g)) {
      if (!LANGUAGE_KEYWORDS.has(match[0].toLowerCase())) names.push(match[0]);
    }
  }
  return [...new Set(names)];
}

export function bindingAdapterFragment({ adapterId, language, changeSetId, file, fileModel, parseImports, importPattern, deterministicEligible = false }) {
  const entities = [];
  const operations = [];
  const dependencies = [];
  const evidence = [];
  const addedBindings = parseImports(fileModel.addedLines || []);
  const removedBindings = parseImports(fileModel.removedLines || []);
  const addedNames = lexicalIdentifiers(fileModel.addedLines || [], importPattern);
  const removedNames = new Set(lexicalIdentifiers(fileModel.removedLines || [], importPattern));
  const netAddedNames = addedNames.filter((name) => !removedNames.has(name));
  const evidenceFor = (summary, excerpt) => {
    const item = createEvidence({ changeSetId, adapterId, path: file.filename, summary, excerpt });
    evidence.push(item);
    return item.id;
  };
  for (const [kind, bindings] of [["add", addedBindings], ["remove", removedBindings]]) {
    for (const item of bindings) {
      const entity = createEntity({ adapterId, kind: "binding", name: item.simpleName, scope: file.filename, language, metadata: { qualified: item.qualified } });
      entities.push(entity);
      const evidenceId = evidenceFor(`${item.qualified} binding is ${kind === "add" ? "added" : "removed"}`, item.source);
      operations.push(createOperation({
        adapterId, kind, entityId: entity.id,
        ...(kind === "add" ? { after: item.qualified } : { before: item.qualified }), evidenceIds: [evidenceId],
        metadata: {
          binding: true, file: file.filename, simpleName: item.simpleName, qualified: item.qualified,
          wildcard: Boolean(item.wildcard), static: Boolean(item.static), conflictEligible: item.conflictEligible !== false && !item.wildcard,
          deterministicEligible,
        },
      }));
    }
  }
  for (const name of netAddedNames) {
    const evidenceId = evidenceFor(`${name} binding is newly required`, name);
    dependencies.push(createDependency({
      adapterId, relation: "requires-binding", target: { kind: "binding", name, scope: file.filename }, status: "added",
      evidenceIds: [evidenceId], metadata: {
        binding: true, file: file.filename,
        localType: fileModel.addedDeclarations?.some((item) => item.name === name) || false,
      },
    }));
  }
  return { adapterId, language, entities, operations, dependencies, assumptions: [], evidence };
}
