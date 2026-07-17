import { createDependency, createEntity, createEvidence, createOperation } from "../scir/index.mjs";

function javaImports(lines) {
  const imports = [];
  for (const line of lines) {
    const match = line.match(/^\s*import\s+(static\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(\.\*)?\s*;/);
    if (!match) continue;
    imports.push({
      qualified: `${match[2]}${match[3] || ""}`,
      simpleName: match[3] ? "*" : match[2].split(".").at(-1),
      static: Boolean(match[1]), wildcard: Boolean(match[3]),
    });
  }
  return imports;
}

function qualifiedTypeReferences(lines) {
  return new Set(lines.flatMap((line) => [...line.matchAll(/\b(?:[a-z_$][\w$]*\.){2,}([A-Z_$][\w$]*)\b/g)].map((match) => match[1])));
}

function javaPackageForPath(filename) {
  const marker = filename.lastIndexOf("/java/");
  if (marker < 0) return null;
  const segments = filename.slice(marker + 6).split("/");
  segments.pop();
  return segments.join(".") || null;
}

export const javaAdapter = Object.freeze({
  id: "java-v0.1",
  supports: ({ filename }) => filename.endsWith(".java"),
  extract({ changeSetId, file, fileModel }) {
    const language = "java";
    const entities = [];
    const operations = [];
    const dependencies = [];
    const evidence = [];
    const addedImports = javaImports(fileModel.addedLines || []);
    const removedImports = javaImports(fileModel.removedLines || []);
    const qualifiedReferences = qualifiedTypeReferences(fileModel.addedLines || []);
    const evidenceFor = (summary, excerpt) => {
      const item = createEvidence({ changeSetId, adapterId: this.id, path: file.filename, summary, excerpt });
      evidence.push(item);
      return item.id;
    };
    for (const [kind, imports] of [["add", addedImports], ["remove", removedImports]]) {
      for (const item of imports) {
        const entity = createEntity({ adapterId: this.id, kind: "binding", name: item.simpleName, scope: file.filename, language, metadata: { qualified: item.qualified } });
        entities.push(entity);
        const evidenceId = evidenceFor(`${item.qualified} import is ${kind === "add" ? "added" : "removed"}`, `import ${item.qualified}`);
        operations.push(createOperation({
          adapterId: this.id, kind, entityId: entity.id,
          ...(kind === "add" ? { after: item.qualified } : { before: item.qualified }), evidenceIds: [evidenceId],
          metadata: {
            binding: true, file: file.filename, simpleName: item.simpleName, qualified: item.qualified, static: item.static, wildcard: item.wildcard,
            deterministicEligible: true,
            conflictEligible: !item.static && !item.wildcard && !item.qualified.startsWith("java.lang.")
              && javaPackageForPath(file.filename) !== item.qualified.split(".").slice(0, -1).join("."),
          },
        }));
      }
    }
    for (const name of (fileModel.netAddedIdentifiers || []).filter((item) => /^[A-Z]/.test(item))) {
      const evidenceId = evidenceFor(`${name} binding is newly required`, name);
      dependencies.push(createDependency({
        adapterId: this.id, relation: "requires-binding", target: { kind: "binding", name, scope: file.filename }, status: "added",
        evidenceIds: [evidenceId], metadata: {
          binding: true, file: file.filename, qualifiedReference: qualifiedReferences.has(name),
          localType: fileModel.addedDeclarations?.some((item) => item.kind === "type" && item.name === name) || false,
        },
      }));
    }
    return { adapterId: this.id, language, entities, operations, dependencies, assumptions: [], evidence };
  },
});
