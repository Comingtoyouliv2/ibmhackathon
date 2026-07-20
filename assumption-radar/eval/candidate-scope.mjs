import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const DEFAULT_IGNORED_ROOTS = Object.freeze([".cache", ".git", "node_modules", "reports"]);

const digest = (value) => createHash("sha256").update(value).digest("hex");

function ignored(path, ignoredRoots) {
  const first = path.split("/")[0];
  return ignoredRoots.has(first);
}

export async function readPathState(root, path) {
  try {
    const absolute = join(root, path);
    const stat = await lstat(absolute);
    const mode = stat.mode & 0o777;
    if (stat.isFile()) return { type: "file", sha256: digest(await readFile(absolute)), mode };
    if (stat.isSymbolicLink()) return { type: "symlink", sha256: digest(`symlink:${await readlink(absolute)}`), mode };
    return { type: "unsupported", sha256: digest(`${stat.mode}:${stat.size}`), mode };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function workspaceEntries(root, options = {}) {
  const ignoredRoots = new Set(options.ignoredRoots || DEFAULT_IGNORED_ROOTS);
  const entries = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (ignored(path, ignoredRoots)) continue;
      if (entry.isDirectory()) await walk(absolute);
      else entries.push(path);
    }
  }
  await walk(root);
  return entries.sort();
}

export async function workspaceChanges(original, candidate, options = {}) {
  const paths = new Set([
    ...(await workspaceEntries(original, options)),
    ...(await workspaceEntries(candidate, options)),
  ]);
  const changed = [];
  for (const path of [...paths].sort()) {
    const [before, after] = await Promise.all([readPathState(original, path), readPathState(candidate, path)]);
    if (before?.type === after?.type && before?.sha256 === after?.sha256 && before?.mode === after?.mode) continue;
    changed.push({
      path,
      beforeSha256: before?.sha256 || null,
      afterSha256: after?.sha256 || null,
      beforeType: before?.type || null,
      afterType: after?.type || null,
      beforeMode: before?.mode ?? null,
      afterMode: after?.mode ?? null,
      deleted: after === null,
    });
  }
  return changed;
}

export function unauthorizedCandidateChanges(changed, allowedTargets) {
  return changed.filter((item) => {
    const allowedPath = allowedTargets.has(item.path) || /^test\/.*\.test\.mjs$/.test(item.path);
    const safeType = [null, "file"].includes(item.beforeType) && [null, "file"].includes(item.afterType);
    return !allowedPath || !safeType;
  });
}
