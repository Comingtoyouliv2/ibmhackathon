import type { Candidate, PullRequestInput, VerificationFinding } from "./analyzer";

type ChangedLine = { sign: "+" | "-"; text: string; oldStart: number };
type Effects = {
  behaviorLines: number;
  writes: Set<string>;
  reads: Set<string>;
  controls: Set<number>;
  collectionGrowth: Set<string>;
  addedLiterals: Set<string>;
  removedLiterals: Set<string>;
  pureLiteralList: boolean;
  evidence: string[];
};

const genericIdentifiers = new Set([
  "public", "private", "protected", "static", "final", "class", "interface", "return", "this", "super",
  "new", "void", "null", "true", "false", "string", "int", "long", "boolean", "if", "else", "for",
  "while", "try", "catch", "throw", "throws", "override", "import", "package", "value", "result", "object",
  "method", "java", "org", "com", "the", "and", "from", "with",
]);

const collectionMutator = /^(?:add|addAll|put|putAll|append|insert|remove|removeAll|clear|push|pop|offer|poll|register\w*|unregister\w*)$/;
const literalPattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
const pureLiteralListPattern = /^\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')(?:\s*,\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))*\s*,?\s*$/;

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function changedLinesByFile(diff: string): Map<string, ChangedLine[]> {
  const files = new Map<string, ChangedLine[]>();
  let file = "";
  let oldStart = 0;
  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (fileMatch) {
      file = normalizePath(fileMatch[1]);
      files.set(file, []);
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)/);
    if (hunkMatch) {
      oldStart = Number(hunkMatch[1]);
      continue;
    }
    if (!file || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      files.get(file)?.push({ sign: line[0] as "+" | "-", text: line.slice(1).trim(), oldStart });
    }
  }
  return files;
}

function isCode(line: string): boolean {
  return Boolean(line) && !/^\s*(?:\/\/|\/\*|\*|\*\/|import\b|package\b|@|[{};,]?$)/.test(line);
}

function isStructuralOnly(line: string): boolean {
  return /^(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)+(?:[\w<>?,.\[\] ]+\s+)?\w+\s*\([^;{}]*\)\s*(?:throws[^{}]+)?\{?$/.test(line)
    || /^(?:public|private|protected)\s+[A-Z][\w$]*\s*\([^)]*\)\s*\{?$/.test(line);
}

function identifiers(line: string): Set<string> {
  return new Set((line.match(/\b[A-Za-z_$][\w$]{2,}\b/g) ?? [])
    .filter((identifier) => !genericIdentifiers.has(identifier.toLowerCase())));
}

function propertyName(method: string, prefix: "get" | "set"): string {
  const raw = method.slice(prefix.length);
  return `${raw.slice(0, 1).toLowerCase()}${raw.slice(1)}`;
}

function effects(lines: ChangedLine[]): Effects {
  const behavioral = lines.filter((line) => isCode(line.text) && !isStructuralOnly(line.text));
  const added = behavioral.filter((line) => line.sign === "+");
  const writes = new Set<string>();
  const reads = new Set<string>();
  const controls = new Set<number>();
  const mutations = new Map<string, { added: number; removed: number }>();
  const addedLiterals = new Set<string>();
  const removedLiterals = new Set<string>();

  for (const entry of behavioral) {
    const addedLine = entry.sign === "+";
    for (const literal of entry.text.match(literalPattern) ?? []) {
      (addedLine ? addedLiterals : removedLiterals).add(literal);
    }
    const line = entry.text.replace(literalPattern, "");
    const assignment = line.match(/(?:^|[;{}])\s*(?:[\w<>?,.\[\]]+\s+)?((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*(?:[+\-*/%]?=|\+\+|--)/);
    if (assignment && addedLine) writes.add(assignment[1].replace(/^this\./, ""));
    if (addedLine && /\breturn\b/.test(line)) writes.add("$return");
    if (addedLine && /\bthrow\b/.test(line)) writes.add("$exception");
    if (addedLine && /\b(?:if|switch|while|for)\s*\(|\b(?:return|throw)\b/.test(line)) controls.add(entry.oldStart);

    for (const call of line.matchAll(/(?:(\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\.)?\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const receiver = call[1]?.replace(/^this\./, "") ?? "this";
      const method = call[2];
      if (/^set[A-Z]/.test(method)) {
        if (addedLine) writes.add(`${receiver}.${propertyName(method, "set")}`);
      } else if (/^get[A-Z]/.test(method)) {
        if (addedLine) reads.add(`${receiver}.${propertyName(method, "get")}`);
      } else if (collectionMutator.test(method) || method.startsWith("add") || method.startsWith("put")) {
        const key = `${receiver}.${method}`;
        const mutation = mutations.get(key) ?? { added: 0, removed: 0 };
        if (addedLine) mutation.added++;
        else mutation.removed++;
        mutations.set(key, mutation);
        if (addedLine) writes.add(`${receiver}.*`);
      }
    }
    if (addedLine) for (const identifier of identifiers(line)) reads.add(identifier);
  }

  const collectionGrowth = new Set([...mutations]
    .filter(([, counts]) => counts.added > counts.removed)
    .map(([key]) => key));
  return {
    behaviorLines: added.length,
    writes,
    reads,
    controls,
    collectionGrowth,
    addedLiterals,
    removedLiterals,
    pureLiteralList: added.length > 0 && added.every((line) => pureLiteralListPattern.test(line.text)),
    evidence: added.slice(0, 6).map((line) => line.text),
  };
}

function intersection(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => right.has(value));
}

function minDistance(left: Set<number>, right: Set<number>): number {
  if (!left.size || !right.size) return Number.POSITIVE_INFINITY;
  return Math.min(...[...left].flatMap((a) => [...right].map((b) => Math.abs(a - b))));
}

function interactionReasons(a: Effects, b: Effects): string[] {
  if (!a.behaviorLines || !b.behaviorLines) return [];
  const reasons: string[] = [];
  const sameWrites = intersection(a.writes, b.writes)
    .filter((state) => !state.endsWith(".*") || (a.collectionGrowth.size > 0 && b.collectionGrowth.size > 0));
  const sameGrowth = intersection(a.collectionGrowth, b.collectionGrowth);
  const semanticWritesA = new Set([...a.writes].filter((state) => !state.endsWith(".*")));
  const semanticWritesB = new Set([...b.writes].filter((state) => !state.endsWith(".*")));
  const directFlow = [...intersection(semanticWritesA, b.reads), ...intersection(semanticWritesB, a.reads)]
    .filter((state) => state.length > 3);
  const literalGrowthA = [...a.addedLiterals].filter((literal) => !a.removedLiterals.has(literal));
  const literalGrowthB = [...b.addedLiterals].filter((literal) => !b.removedLiterals.has(literal));

  if (sameWrites.length) reasons.push(`같은 상태 쓰기: ${sameWrites.join(", ")}`);
  if (sameGrowth.length) reasons.push(`같은 컬렉션 크기 변경: ${sameGrowth.join(", ")}`);
  if (directFlow.length) reasons.push(`한쪽 쓰기와 다른 쪽 읽기 연결: ${[...new Set(directFlow)].join(", ")}`);
  if (minDistance(a.controls, b.controls) <= 40) reasons.push("인접한 제어 흐름을 두 변경이 동시에 수정");
  if (a.pureLiteralList && b.pureLiteralList && literalGrowthA.length && literalGrowthB.length) {
    reasons.push("같은 리터럴 컬렉션의 크기를 두 변경이 동시에 수정");
  }
  return reasons;
}

export function judgeSemanticInteractions(prs: PullRequestInput[], candidates: Candidate[]): VerificationFinding[] {
  const byPr = new Map(prs.map((pr) => [pr.number, pr]));
  const parsed = new Map(prs.map((pr) => [pr.number, changedLinesByFile(pr.diff)]));
  const findings: VerificationFinding[] = [];
  for (const candidate of candidates) {
    const prA = byPr.get(candidate.a);
    const prB = byPr.get(candidate.b);
    const filesA = parsed.get(candidate.a);
    const filesB = parsed.get(candidate.b);
    if (!prA || !prB || !filesA || !filesB) continue;
    for (const file of [...filesA.keys()].filter((path) => filesB.has(path))) {
      const effectsA = effects(filesA.get(file) ?? []);
      const effectsB = effects(filesB.get(file) ?? []);
      const reasons = interactionReasons(effectsA, effectsB);
      if (!reasons.length) continue;
      findings.push({
        ...candidate,
        sharedResources: [`file:${file}`],
        evidenceStrength: "strong",
        verdict: "needs_verification",
        reasonCode: "patch_interaction",
        rationale: `${file}에서 ${reasons.join("; ")} 신호가 발견됐습니다. combined 실행으로 실제 간섭 여부를 확인해야 합니다.`,
        evidence: [
          ...effectsA.evidence.map((line) => `PR #${prA.number}: ${line}`),
          ...effectsB.evidence.map((line) => `PR #${prB.number}: ${line}`),
        ].slice(0, 10),
      });
      break;
    }
  }
  return findings;
}
