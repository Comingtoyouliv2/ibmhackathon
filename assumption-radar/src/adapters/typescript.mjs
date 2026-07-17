import { bindingAdapterFragment } from "./binding.mjs";

function parseTypeScriptImports(lines) {
  const bindings = [];
  for (const line of lines) {
    const source = line.replace(/\/\/.*$/, "").trim();
    const moduleName = source.match(/\sfrom\s+["']([^"']+)["']/)?.[1];
    if (!moduleName) continue;
    const namespace = source.match(/^import\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) bindings.push({ qualified: `${moduleName}.*`, simpleName: namespace[1], source });
    const named = source.match(/^import\s+(?:type\s+)?\{([^}]+)\}/);
    if (named) {
      for (const item of named[1].split(",").map((value) => value.trim()).filter(Boolean)) {
        const match = item.match(/^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (match) bindings.push({ qualified: `${moduleName}.${match[1]}`, simpleName: match[2] || match[1], source });
      }
    }
    const defaultImport = source.match(/^import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from\b)/);
    if (defaultImport && !namespace && !named) bindings.push({ qualified: `${moduleName}.default`, simpleName: defaultImport[1], source });
  }
  return bindings;
}

export const typescriptAdapter = Object.freeze({
  id: "typescript-v0.1",
  supports: ({ filename }) => /\.(?:ts|tsx)$/.test(filename),
  extract(context) {
    return bindingAdapterFragment({
      ...context, adapterId: this.id, language: "typescript", parseImports: parseTypeScriptImports,
      importPattern: /^\s*import\b/,
    });
  },
});
