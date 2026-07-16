import type { Candidate, FileChange, IntentCard } from "./analyzer";

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function changes(card: Pick<IntentCard, "files" | "fileChanges">): FileChange[] {
  return card.fileChanges?.length ? card.fileChanges : card.files.map((path) => ({ path, operation: "modified" }));
}

function addPair(pairs: Map<string, Candidate>, left: number, right: number, resource: string, reason: string) {
  if (left === right) return;
  const [a, b] = left < right ? [left, right] : [right, left];
  const key = pairKey(a, b);
  const existing = pairs.get(key);
  pairs.set(key, {
    a, b,
    sharedResources: [...new Set([...(existing?.sharedResources ?? []), resource])].sort(),
    evidenceStrength: "strong",
    joinReasons: [...new Set([...(existing?.joinReasons ?? []), reason])].sort(),
    candidateScore: 10,
    candidateTier: "strong",
    candidateSources: ["git_path"],
  });
}

export function generateFileOverlapCandidates(cards: Array<Pick<IntentCard, "pr" | "files" | "fileChanges">>): Candidate[] {
  const postings = new Map<string, number[]>();
  const operations = new Map<string, Array<{ pr: number; renamed: boolean }>>();
  for (const card of cards) {
    for (const change of changes(card)) {
      for (const file of new Set([change.path, change.previousPath].filter(Boolean) as string[])) {
        postings.set(file, [...(postings.get(file) ?? []), card.pr]);
        operations.set(file, [...(operations.get(file) ?? []), { pr: card.pr, renamed: change.operation === "renamed" }]);
      }
    }
  }

  const pairs = new Map<string, Candidate>();
  for (const [file, prs] of postings) {
    for (let left = 0; left < prs.length; left++) {
      for (let right = left + 1; right < prs.length; right++) {
        const renamed = operations.get(file)?.some((entry) => entry.pr === prs[left] && entry.renamed)
          || operations.get(file)?.some((entry) => entry.pr === prs[right] && entry.renamed);
        addPair(pairs, prs[left], prs[right], `file:${file}`, renamed ? "rename_path_overlap:strong" : "file_overlap:strong");
      }
    }
  }
  // A file added at `config` conflicts with another PR adding `config/app.yml`.
  // Walking ancestors is linear in path depth and avoids an all-path cartesian product.
  for (const [file, prs] of postings) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const ancestor = parts.slice(0, depth).join("/");
      for (const ancestorPr of postings.get(ancestor) ?? []) {
        for (const descendantPr of prs) addPair(pairs, ancestorPr, descendantPr, `path-prefix:${ancestor}↔${file}`, "file_directory_overlap:strong");
      }
    }
  }
  return [...pairs.values()].sort((left, right) => left.a - right.a || left.b - right.b);
}
