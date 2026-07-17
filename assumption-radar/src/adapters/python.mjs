import { bindingAdapterFragment } from "./binding.mjs";

function splitImports(value) {
  return value.replace(/[()]/g, "").split(",").map((item) => item.trim()).filter(Boolean);
}

function parsePythonImports(lines) {
  const bindings = [];
  for (const line of lines) {
    const source = line.replace(/#.*$/, "").trim();
    let match = source.match(/^from\s+([A-Za-z_][\w.]*)\s+import\s+(.+)$/);
    if (match) {
      for (const item of splitImports(match[2])) {
        if (item === "*") { bindings.push({ qualified: `${match[1]}.*`, simpleName: "*", wildcard: true, source }); continue; }
        const named = item.match(/^([A-Za-z_][\w]*)(?:\s+as\s+([A-Za-z_][\w]*))?$/);
        if (named) bindings.push({ qualified: `${match[1]}.${named[1]}`, simpleName: named[2] || named[1], source });
      }
      continue;
    }
    match = source.match(/^import\s+(.+)$/);
    if (!match) continue;
    for (const item of splitImports(match[1])) {
      const named = item.match(/^([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_][\w]*))?$/);
      if (named) bindings.push({ qualified: named[1], simpleName: named[2] || named[1].split(".")[0], source });
    }
  }
  return bindings;
}

export const pythonAdapter = Object.freeze({
  id: "python-v0.1",
  supports: ({ filename }) => filename.endsWith(".py"),
  extract(context) {
    return bindingAdapterFragment({
      ...context, adapterId: this.id, language: "python", parseImports: parsePythonImports,
      importPattern: /^\s*(?:from\s+\S+\s+import|import\s+)/,
    });
  },
});
