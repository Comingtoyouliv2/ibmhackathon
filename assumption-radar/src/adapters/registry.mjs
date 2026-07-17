import { assertValidChangeSet, createChangeSet } from "../scir/index.mjs";
import { genericAdapter } from "./generic.mjs";
import { javaAdapter } from "./java.mjs";
import { pythonAdapter } from "./python.mjs";
import { typescriptAdapter } from "./typescript.mjs";

const LANGUAGE_BY_EXTENSION = Object.freeze({
  c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", go: "go", h: "c", hpp: "cpp",
  java: "java", js: "javascript", jsx: "javascript", kt: "kotlin", kts: "kotlin",
  mjs: "javascript", php: "php", py: "python", rb: "ruby", rs: "rust", scala: "scala",
  swift: "swift", ts: "typescript", tsx: "typescript",
});

export const SUPPORTED_LANGUAGES = Object.freeze([...new Set(Object.values(LANGUAGE_BY_EXTENSION))].sort());

export function languageForFile(filename) {
  const extension = filename.split(".").at(-1)?.toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] || "unknown";
}

export const DEFAULT_ADAPTERS = Object.freeze([genericAdapter, javaAdapter, pythonAdapter, typescriptAdapter]);

export function buildScirChangeSet(pr, files, adapters = DEFAULT_ADAPTERS) {
  const changeSetId = String(pr.id ?? pr.number ?? pr.headSha ?? "change-set");
  const fragments = [];
  for (let index = 0; index < files.length; index += 1) {
    const fileModel = files[index];
    const file = (pr.files || [])[index] || fileModel;
    const language = languageForFile(file.filename);
    for (const adapter of adapters) {
      if (!adapter.supports({ filename: file.filename, language, file, fileModel })) continue;
      fragments.push(adapter.extract({ changeSetId, pr, file, fileModel, language }));
    }
  }
  return assertValidChangeSet(createChangeSet({ changeSetId, fragments }));
}
