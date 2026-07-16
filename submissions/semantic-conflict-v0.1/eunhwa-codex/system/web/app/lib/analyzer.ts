import type { LlmJudgeSummary, LlmSemanticFinding } from "./llm-judge";
import type { CombinedVerification, CombinedVerificationSummary } from "./combined-verifier";
import { generateFileOverlapCandidates } from "./pair-merge.ts";
import { judgeSemanticInteractions } from "./semantic-interactions.ts";

export type PullRequestInput = {
  number: number;
  title: string;
  url?: string;
  headSha?: string;
  baseSha?: string;
  pairMergeBaseSha?: string;
  ciPassed: boolean;
  ciStatus?: "passed" | "failed" | "pending" | "missing";
  mergeable: boolean;
  files: string[];
  fileChanges?: FileChange[];
  diff: string;
};

export type FileOperation = "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unknown";

export type FileChange = {
  path: string;
  previousPath?: string;
  operation: FileOperation;
};

export type ContractFamily = "api_arity" | "config_key" | "event_channel" | "semantic_surface";
export type EvidenceStrength = "strong" | "medium" | "weak";
export type ContractKind =
  | "definition_change"
  | "call_assumption"
  | "config_change"
  | "config_assumption"
  | "event_change"
  | "event_assumption"
  | "surface_change";

export type ContractFact = {
  resource: string;
  aliases?: string[];
  family?: ContractFamily;
  kind: ContractKind;
  symbol: string;
  arity: number;
  previousArity?: number;
  minArity?: number;
  maxArity?: number | null;
  previousMinArity?: number;
  previousMaxArity?: number | null;
  strictArity?: boolean;
  identityStrength?: "strong" | "weak";
  file: string;
  evidence: string;
};

export type IntentCard = {
  pr: number;
  title: string;
  url?: string;
  headSha?: string;
  baseSha?: string;
  pairMergeBaseSha?: string;
  ciStatus?: "passed" | "failed" | "pending" | "missing";
  files: string[];
  fileChanges?: FileChange[];
  touchedResources: string[];
  assumptions: string[];
  facts: ContractFact[];
};

export type Candidate = {
  a: number;
  b: number;
  sharedResources: string[];
  evidenceStrength?: EvidenceStrength;
  joinReasons?: string[];
  candidateScore?: number;
  candidateTier?: "strong" | "medium" | "weak";
  candidateSources?: Array<"git_path" | "contract" | "lexical">;
};

export type CandidateSummary = {
  gitPairs: number;
  contractPairs: number;
  broadSemanticPairs: number;
  strongSemanticPairs: number;
  mediumSemanticPairs: number;
  weakSemanticPairs: number;
};

export type FindingSummary = {
  conflicts: number;
  needsVerification: number;
  pairTextConflicts: number;
  llmFindings: number;
  pairMergeErrors: number;
  scanErrors: number;
};

export type Conflict = Candidate & {
  verdict: "semantic_conflict";
  confidence: number;
  evidenceLevel?: "static_proof";
  rationale: string;
  evidence: string[];
};

export type VerificationFinding = Candidate & {
  verdict: "needs_verification";
  reasonCode: "weak_symbol_identity" | "runtime_contract" | "pair_merge_required" | "patch_interaction" | "ci_baseline_unverified";
  rationale: string;
  evidence: string[];
};

export type PairTextConflict = Candidate & {
  verdict: "text_conflict";
  rationale: string;
  evidence: string[];
  verifiedAt: string;
};

export type AnalysisResult = {
  totalOpenPrs?: number;
  scannedPrs?: number;
  eligibleGatePrs?: number;
  pairMergeGatePrs?: number;
  eligiblePrs: number;
  pairMergePrs?: number;
  pairMergeUnavailablePrs?: number;
  pairMergeVerifiedAt?: string;
  pairMergeErrors?: Array<{ a: number; b: number; reason: string }>;
  llmJudgeSummary?: LlmJudgeSummary;
  llmFindings?: LlmSemanticFinding[];
  llmJudgeErrors?: Array<{ a: number; b: number; reason: string }>;
  combinedVerificationSummary?: CombinedVerificationSummary;
  combinedVerifications?: CombinedVerification[];
  combinedVerificationErrors?: Array<{ a: number; b: number; reason: string }>;
  cards: IntentCard[];
  pairMergeCards?: IntentCard[];
  candidates: Candidate[];
  semanticCandidates?: Candidate[];
  gitCandidates?: Candidate[];
  candidateSummary?: CandidateSummary;
  findingSummary?: FindingSummary;
  conflicts: Conflict[];
  needsVerification?: VerificationFinding[];
  pairTextConflicts?: PairTextConflict[];
  excluded: Array<{ pr: number; reason: string }>;
};

type Signature = { min: number; max: number | null };
type ParsedDefinition = { symbol: string; signature: Signature };
type DiffLine = { sign: "+" | "-" | " "; code: string; scope?: string };
type DiffFile = { file: string; lines: DiffLine[] };
type ImportBinding = { module: string; exported: string };

const definitionPatterns = [
  /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/,
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/,
  /(?:async\s+)?def\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/,
  /(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/,
  /func\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/,
  /(?:public|private|protected|static|async|final|synchronized|override|open|internal|suspend|fun|const|let|var|[A-Za-z_$][\w$<>,.?\[\] ]*)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:\{|=>|:)/,
];

const ignoredCalls = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "typeof", "sizeof",
  "def", "fn", "func", "class", "interface", "import", "export",
]);

const genericApiNames = new Set([
  "init", "create", "new", "get", "set", "run", "build", "call", "open", "close", "start", "stop", "load", "save",
]);

const strictArityExtensions = new Set([
  ".ts", ".tsx", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".cs", ".c", ".cc", ".cpp", ".swift",
]);

const strengthRank: Record<EvidenceStrength, number> = { weak: 1, medium: 2, strong: 3 };

function normalizePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function dirname(value: string): string {
  const normalized = normalizePath(value);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "." : normalized.slice(0, index);
}

function joinPath(...values: string[]): string {
  return normalizePath(values.join("/"));
}

function extension(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1).match(/(\.[^.]+)$/)?.[1] ?? "";
}

function isComment(line: string): boolean {
  return /^(?:\/\/|\/\*|\*|#|--)/.test(line);
}

function splitTopLevel(raw: string): string[] {
  const value = raw.trim();
  if (!value || value === "void") return [];
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if ("([{<".includes(char)) depth++;
    if (")]}>".includes(char)) depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function parameterRange(raw: string, file: string): Signature {
  const fileExtension = extension(file).toLowerCase();
  let min = 0;
  let max = 0;
  for (const rawPart of splitTopLevel(raw)) {
    const part = rawPart.trim();
    if (!part || part === "/" || part === "*") continue;
    if (["self", "cls", "&self", "&mut self", "mut self"].includes(part)) continue;
    if (fileExtension.startsWith(".ts") && /^this\s*:/.test(part)) continue;
    if (/^(?:\.\.\.|\*\*?|\.\.\.)/.test(part)) {
      max = Number.POSITIVE_INFINITY;
      continue;
    }
    const optional = /\?(?:\s*:|\s*$)/.test(part) || part.includes("=");
    if (!optional) min++;
    if (Number.isFinite(max)) max++;
  }
  return { min, max: Number.isFinite(max) ? max : null };
}

function parseDefinition(line: string, file: string): ParsedDefinition | null {
  for (const pattern of definitionPatterns) {
    const match = line.match(pattern);
    if (match && !ignoredCalls.has(match[1])) {
      return { symbol: match[1], signature: parameterRange(match[2], file) };
    }
  }
  return null;
}

function parseDiff(pr: PullRequestInput): DiffFile[] {
  const files = new Map<string, DiffFile>();
  let current = pr.files[0] ?? "unknown";
  const ensure = (file: string): DiffFile => {
    const existing = files.get(file);
    if (existing) return existing;
    const created = { file, lines: [] };
    files.set(file, created);
    return created;
  };
  ensure(current);
  let currentScope: string | undefined;

  for (const raw of pr.diff.split("\n")) {
    const diffHeader = raw.match(/^diff --git a\/.+ b\/(.+)$/);
    if (diffHeader) {
      current = diffHeader[1];
      currentScope = undefined;
      ensure(current);
      continue;
    }
    const fileHeader = raw.match(/^\+\+\+ b\/(.+)$/);
    if (fileHeader) {
      current = fileHeader[1];
      currentScope = undefined;
      ensure(current);
      continue;
    }
    const hunkHeader = raw.match(/^@@[^@]*@@\s*(.*)$/);
    if (hunkHeader) {
      currentScope = structuralAnchor(hunkHeader[1], current);
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    const sign = raw[0];
    if (sign !== "+" && sign !== "-" && sign !== " ") continue;
    ensure(current).lines.push({ sign, code: raw.slice(1), scope: currentScope });
  }
  return [...files.values()];
}

function structuralAnchor(raw: string, file: string): string | undefined {
  const code = raw.trim();
  if (!code) return undefined;
  const definition = parseDefinition(code, file);
  if (definition) return definition.symbol;
  const type = code.match(/\b(?:class|interface|enum|struct|trait|protocol|module|namespace)\s+([A-Za-z_$][\w$]*)/);
  if (type) return type[1];
  return undefined;
}

function modulePath(file: string): string {
  const normalized = normalizePath(file).replace(/^\.\//, "");
  return normalized.replace(/\.(?:d\.)?(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|c|cc|cpp|swift)$/i, "");
}

function definitionResources(file: string, symbol: string): { resource: string; aliases: string[] } {
  const moduleId = modulePath(file);
  const aliases = genericApiNames.has(symbol) ? [] : [`api-name:${symbol}`];
  if (/\/(?:index|__init__)$/.test(moduleId)) {
    aliases.unshift(`api:${dirname(moduleId)}#${symbol}`);
  }
  return { resource: `api:${moduleId}#${symbol}`, aliases };
}

function resolveModule(importer: string, specifier: string): string | null {
  if (specifier.startsWith(".")) {
    return modulePath(joinPath(dirname(importer), specifier));
  }
  return null;
}

function resolvePythonModule(importer: string, specifier: string): string | null {
  const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
  if (dots === 0) return null;
  let base = dirname(importer);
  for (let index = 1; index < dots; index++) base = dirname(base);
  const rest = specifier.slice(dots).replace(/\./g, "/");
  return modulePath(joinPath(base, rest));
}

function importBindings(file: DiffFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const { sign, code: rawCode } of file.lines) {
    if (sign === "-") continue;
    const code = rawCode.trim();
    let match = code.match(/^import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/);
    if (match) {
      const moduleId = resolveModule(file.file, match[2]);
      if (moduleId) {
        for (const item of match[1].split(",")) {
          const [exported, local = exported] = item.trim().split(/\s+as\s+/);
          if (exported && local) bindings.set(local, { module: moduleId, exported });
        }
      }
      continue;
    }
    match = code.match(/^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/);
    if (match) {
      const moduleId = resolveModule(file.file, match[2]);
      if (moduleId) bindings.set(`${match[1]}.*`, { module: moduleId, exported: "*" });
      continue;
    }
    match = code.match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
    if (match) {
      const moduleId = resolvePythonModule(file.file, match[1]);
      if (moduleId) {
        for (const item of match[2].split(",")) {
          const [exported, local = exported] = item.trim().split(/\s+as\s+/);
          if (exported && local && exported !== "*") bindings.set(local, { module: moduleId, exported });
        }
      }
    }
  }
  return bindings;
}

function closingParen(line: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let index = open; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === quote && line[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")" && --depth === 0) return index;
  }
  return -1;
}

function callsInLine(line: string): Array<{ expression: string; symbol: string; arity: number }> {
  const calls: Array<{ expression: string; symbol: string; arity: number }> = [];
  const pattern = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;
  for (const match of line.matchAll(pattern)) {
    const expression = match[1];
    const symbol = expression.split(".").at(-1)!;
    if (ignoredCalls.has(symbol)) continue;
    const open = (match.index ?? 0) + match[0].lastIndexOf("(");
    const close = closingParen(line, open);
    if (close < 0) continue;
    calls.push({ expression, symbol, arity: splitTopLevel(line.slice(open + 1, close)).length });
  }
  return calls;
}

function callResources(file: string, expression: string, symbol: string, imports: Map<string, ImportBinding>): { resource: string; aliases: string[]; identityStrength: "strong" | "weak" } {
  const weakAliases = genericApiNames.has(symbol) ? [] : [`api-name:${symbol}`];
  const direct = imports.get(expression);
  if (direct) return { resource: `api:${direct.module}#${direct.exported}`, aliases: weakAliases, identityStrength: "strong" };
  const [namespace, member] = expression.split(".");
  const namespaceImport = member ? imports.get(`${namespace}.*`) : undefined;
  if (namespaceImport) return { resource: `api:${namespaceImport.module}#${member}`, aliases: weakAliases, identityStrength: "strong" };
  if (!member) return { resource: `api:${modulePath(file)}#${symbol}`, aliases: weakAliases, identityStrength: "weak" };
  return { resource: genericApiNames.has(symbol) ? `api-unresolved:${modulePath(file)}#${symbol}` : `api-name:${symbol}`, aliases: [], identityStrength: "weak" };
}

function configKeys(code: string): string[] {
  const keys: string[] = [];
  const patterns = [
    /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /\b(?:Deno\.env\.get|os\.getenv|System\.getenv|env::var|std::env::var)\s*\(\s*["']([^"']+)["']/g,
    /\bos\.environ\s*\[\s*["']([^"']+)["']\s*\]/g,
  ];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) keys.push(match[1]);
  return [...new Set(keys)];
}

function eventCalls(code: string): Array<{ role: "producer" | "consumer"; name: string; evidence: string }> {
  const events: Array<{ role: "producer" | "consumer"; name: string; evidence: string }> = [];
  const patterns: Array<{ role: "producer" | "consumer"; pattern: RegExp }> = [
    { role: "producer", pattern: /\b(?:emit|publish)\s*\(\s*["']([^"']+)["']/g },
    { role: "consumer", pattern: /\b(?:on|once|subscribe|addEventListener)\s*\(\s*["']([^"']+)["']/g },
  ];
  for (const { role, pattern } of patterns) {
    for (const match of code.matchAll(pattern)) events.push({ role, name: match[1], evidence: code.trim() });
  }
  return events;
}

function familyOf(fact: ContractFact): ContractFamily {
  if (fact.family) return fact.family;
  if (fact.kind.startsWith("config")) return "config_key";
  if (fact.kind.startsWith("event")) return "event_channel";
  if (fact.kind === "surface_change") return "semantic_surface";
  return "api_arity";
}

function isChange(fact: ContractFact): boolean {
  return fact.kind === "definition_change" || fact.kind === "config_change" || fact.kind === "event_change" || fact.kind === "surface_change";
}

function isAssumption(fact: ContractFact): boolean {
  return fact.kind === "call_assumption" || fact.kind === "config_assumption" || fact.kind === "event_assumption";
}

function factKeys(fact: ContractFact): string[] {
  const aliases = fact.kind === "call_assumption" && fact.identityStrength === "strong" ? [] : fact.aliases ?? [];
  return [...new Set([fact.resource, ...aliases])].filter((key) => !(key.startsWith("api-name:") && genericApiNames.has(key.slice("api-name:".length))));
}

function strengthFor(family: ContractFamily, key: string): EvidenceStrength {
  if (key.startsWith("api-name:")) return "weak";
  if (family === "semantic_surface") return key.startsWith("surface-name:") ? "weak" : "medium";
  return family === "api_arity" ? "strong" : "medium";
}

export function extractIntentCard(pr: PullRequestInput): IntentCard {
  const removedDefinitions = new Map<string, { definition: ParsedDefinition; file: string; evidence: string }>();
  const addedDefinitions = new Map<string, { definition: ParsedDefinition; file: string; evidence: string }>();
  const facts: ContractFact[] = [];

  for (const diffFile of parseDiff(pr)) {
    const imports = importBindings(diffFile);
    const removedConfig: Array<{ key: string; evidence: string }> = [];
    const addedConfig: Array<{ key: string; evidence: string }> = [];
    const removedProducers: Array<{ name: string; evidence: string }> = [];
    const addedProducers: Array<{ name: string; evidence: string }> = [];
    const changedSurfaces = new Map<string, string>();

    for (const { sign, code: rawCode, scope } of diffFile.lines) {
      if (sign !== "+" && sign !== "-") continue;
      const code = rawCode.trim();
      if (!code || isComment(code)) continue;
      const definition = parseDefinition(code, diffFile.file);
      const anchor = structuralAnchor(code, diffFile.file) ?? scope;
      if (anchor) changedSurfaces.set(anchor, code);
      if (definition) {
        const target = sign === "+" ? addedDefinitions : removedDefinitions;
        target.set(`${diffFile.file}#${definition.symbol}`, { definition, file: diffFile.file, evidence: code });
      }
      if (sign === "+") {
        for (const call of callsInLine(code)) {
          if (call.symbol === definition?.symbol) continue;
          const identity = callResources(diffFile.file, call.expression, call.symbol, imports);
          facts.push({
            resource: identity.resource,
            aliases: identity.aliases,
            family: "api_arity",
            kind: "call_assumption",
            symbol: call.symbol,
            arity: call.arity,
            identityStrength: identity.identityStrength,
            file: diffFile.file,
            evidence: code,
          });
        }
      }

      for (const key of configKeys(code)) {
        const entry = { key, evidence: code };
        if (sign === "+") addedConfig.push(entry);
        else removedConfig.push(entry);
      }
      for (const event of eventCalls(code)) {
        if (event.role === "producer") {
          if (sign === "+") addedProducers.push(event);
          else removedProducers.push(event);
        } else if (sign === "+") {
          facts.push({
            resource: `event:${event.name}`,
            family: "event_channel",
            kind: "event_assumption",
            symbol: event.name,
            arity: 0,
            file: diffFile.file,
            evidence: event.evidence,
          });
        }
      }
    }

    for (const [anchor, evidence] of changedSurfaces) {
      const moduleId = modulePath(diffFile.file);
      facts.push({
        resource: `surface:${moduleId}#${anchor}`,
        aliases: genericApiNames.has(anchor) ? [] : [`surface-name:${anchor}`],
        family: "semantic_surface",
        kind: "surface_change",
        symbol: anchor,
        arity: 0,
        file: diffFile.file,
        evidence,
      });
    }

    const uniqueAddedConfig = [...new Map(addedConfig.map((entry) => [entry.key, entry])).values()];
    const uniqueRemovedConfig = [...new Map(removedConfig.map((entry) => [entry.key, entry])).values()];
    for (const entry of uniqueAddedConfig) {
      facts.push({
        resource: `config:${entry.key}`,
        family: "config_key",
        kind: "config_assumption",
        symbol: entry.key,
        arity: 0,
        file: diffFile.file,
        evidence: entry.evidence,
      });
    }
    if (uniqueRemovedConfig.length === 1 && uniqueAddedConfig.length === 1 && uniqueRemovedConfig[0].key !== uniqueAddedConfig[0].key) {
      facts.push({
        resource: `config:${uniqueRemovedConfig[0].key}`,
        family: "config_key",
        kind: "config_change",
        symbol: uniqueRemovedConfig[0].key,
        arity: 0,
        file: diffFile.file,
        evidence: `${uniqueRemovedConfig[0].evidence} → ${uniqueAddedConfig[0].evidence}`,
      });
    }

    const uniqueRemovedEvents = [...new Map(removedProducers.map((entry) => [entry.name, entry])).values()];
    const uniqueAddedEvents = [...new Map(addedProducers.map((entry) => [entry.name, entry])).values()];
    if (uniqueRemovedEvents.length === 1 && uniqueAddedEvents.length === 1 && uniqueRemovedEvents[0].name !== uniqueAddedEvents[0].name) {
      facts.push({
        resource: `event:${uniqueRemovedEvents[0].name}`,
        family: "event_channel",
        kind: "event_change",
        symbol: uniqueRemovedEvents[0].name,
        arity: 0,
        file: diffFile.file,
        evidence: `${uniqueRemovedEvents[0].evidence} → ${uniqueAddedEvents[0].evidence}`,
      });
    }
  }

  for (const [key, next] of addedDefinitions) {
    const previous = removedDefinitions.get(key);
    if (!previous) continue;
    const before = previous.definition.signature;
    const after = next.definition.signature;
    if (before.min === after.min && before.max === after.max) continue;
    const identity = definitionResources(next.file, next.definition.symbol);
    facts.push({
      resource: identity.resource,
      aliases: identity.aliases,
      family: "api_arity",
      kind: "definition_change",
      symbol: next.definition.symbol,
      arity: after.min,
      previousArity: before.min,
      minArity: after.min,
      maxArity: after.max,
      previousMinArity: before.min,
      previousMaxArity: before.max,
      strictArity: strictArityExtensions.has(extension(next.file).toLowerCase()),
      file: next.file,
      evidence: `${previous.evidence} → ${next.evidence}`,
    });
  }

  const touchedResources = [...new Set(facts.map((fact) => fact.resource))].sort();
  const assumptions = facts.map((fact) => {
    if (fact.kind === "call_assumption") return `${fact.symbol} accepts ${fact.arity} argument(s)`;
    if (fact.kind === "definition_change") return `${fact.symbol} callers fit the new ${fact.minArity}..${fact.maxArity ?? "∞"} argument range`;
    if (fact.kind === "config_change") return `${fact.symbol} readers migrate to the replacement config key`;
    if (fact.kind === "config_assumption") return `${fact.symbol} remains a readable config key`;
    if (fact.kind === "event_change") return `${fact.symbol} subscribers migrate to the replacement event`;
    if (fact.kind === "surface_change") return `${fact.symbol} preserves its behavioral contract across concurrent changes`;
    return `${fact.symbol} remains a published event channel`;
  });
  return {
    pr: pr.number,
    title: pr.title,
    url: pr.url,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    pairMergeBaseSha: pr.pairMergeBaseSha,
    ciStatus: pr.ciStatus ?? (pr.ciPassed ? "passed" : "failed"),
    files: pr.files,
    fileChanges: pr.fileChanges ?? pr.files.map((path) => ({ path, operation: "modified" as const })),
    touchedResources,
    assumptions,
    facts,
  };
}

export function generateCandidates(cards: IntentCard[]): Candidate[] {
  type Posting = { pr: number; fact: ContractFact; strength: EvidenceStrength };
  const postings = new Map<string, Posting[]>();
  for (const card of cards) {
    for (const fact of card.facts) {
      const family = familyOf(fact);
      for (const key of factKeys(fact)) {
        postings.set(key, [...(postings.get(key) ?? []), { pr: card.pr, fact, strength: strengthFor(family, key) }]);
      }
    }
  }

  type Match = { resource: string; strength: EvidenceStrength; family: ContractFamily };
  const pairs = new Map<string, { a: number; b: number; matches: Match[] }>();
  for (const [resource, entries] of postings) {
    for (let left = 0; left < entries.length; left++) {
      for (let right = left + 1; right < entries.length; right++) {
        const aEntry = entries[left];
        const bEntry = entries[right];
        if (aEntry.pr === bEntry.pr || familyOf(aEntry.fact) !== familyOf(bEntry.fact)) continue;
        const family = familyOf(aEntry.fact);
        const changeAssumption = (isChange(aEntry.fact) && isAssumption(bEntry.fact)) || (isAssumption(aEntry.fact) && isChange(bEntry.fact));
        const concurrentSurfaceChanges = family === "semantic_surface" && isChange(aEntry.fact) && isChange(bEntry.fact);
        if (!changeAssumption && !concurrentSurfaceChanges) continue;
        const [a, b] = aEntry.pr < bEntry.pr ? [aEntry.pr, bEntry.pr] : [bEntry.pr, aEntry.pr];
        const key = `${a}:${b}`;
        const pair = pairs.get(key) ?? { a, b, matches: [] };
        pair.matches.push({
          resource,
          strength: strengthRank[aEntry.strength] < strengthRank[bEntry.strength] ? aEntry.strength : bEntry.strength,
          family: familyOf(aEntry.fact),
        });
        pairs.set(key, pair);
      }
    }
  }

  return [...pairs.values()]
    .map((pair) => {
      const best = pair.matches.reduce<EvidenceStrength>((current, match) =>
        strengthRank[match.strength] > strengthRank[current] ? match.strength : current, "weak");
      const selected = pair.matches.filter((match) => strengthRank[match.strength] === strengthRank[best]);
      return {
        a: pair.a,
        b: pair.b,
        sharedResources: [...new Set(selected.map((match) => match.resource))].sort(),
        evidenceStrength: best,
        joinReasons: [...new Set(selected.map((match) => `${match.family}:${match.strength}`))].sort(),
      };
    })
    .sort((left, right) => left.a - right.a || left.b - right.b);
}

type BroadProfile = {
  files: Set<string>;
  domains: Set<string>;
  declarations: Set<string>;
  identifiers: Set<string>;
  literals: Set<string>;
};

const lexicalStopwords = new Set([
  "return", "public", "private", "protected", "static", "final", "class", "interface", "extends",
  "implements", "import", "export", "package", "throws", "throw", "this", "super", "true", "false",
  "null", "void", "string", "object", "const", "function", "async", "await", "from", "with", "while",
  "else", "case", "default", "value", "result", "error", "test", "main", "source", "undefined",
]);

function pathDomains(file: string): string[] {
  const normalized = normalizePath(file);
  const parts = normalized.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function broadProfile(card: IntentCard): BroadProfile {
  const files = new Set(card.files.map(normalizePath));
  const domains = new Set([...files].flatMap(pathDomains));
  const declarations = new Set(card.facts
    .filter((fact) => fact.kind === "definition_change" || fact.kind === "surface_change")
    .map((fact) => fact.symbol));
  const evidence = card.facts.map((fact) => fact.evidence).join("\n");
  const identifiers = new Set([...evidence.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]{3,}\b/g)]
    .map((match) => match[0])
    .filter((token) => !lexicalStopwords.has(token.toLowerCase()) && !genericApiNames.has(token))
    .slice(0, 160));
  const literals = new Set([...evidence.matchAll(/["']([A-Za-z0-9_.:/-]{3,80})["']/g)]
    .map((match) => match[1])
    .filter((value) => !value.startsWith("http://") && !value.startsWith("https://")));
  return { files, domains, declarations, identifiers, literals };
}

function strongestTier(score: number, hasExactFile: boolean, hasDeclaration: boolean): "strong" | "medium" | "weak" {
  if (hasExactFile || hasDeclaration || score >= 9) return "strong";
  if (score >= 4) return "medium";
  return "weak";
}

/**
 * Recall-oriented semantic candidate union. This intentionally does not call a
 * pair a conflict: it only preserves pairs that deserve static, LLM, or runtime
 * verification when exact contract extraction could not prove the relation.
 */
export function generateBroadSemanticCandidates(cards: IntentCard[], contractCandidates = generateCandidates(cards)): Candidate[] {
  const profiles = new Map(cards.map((card) => [card.pr, broadProfile(card)]));
  const postings = new Map<string, number[]>();
  const add = (key: string, pr: number) => postings.set(key, [...(postings.get(key) ?? []), pr]);
  for (const card of cards) {
    const profile = profiles.get(card.pr)!;
    for (const file of profile.files) add(`file:${file}`, card.pr);
    for (const domain of profile.domains) {
      for (const declaration of profile.declarations) add(`subtree_declaration:${domain}:${declaration}`, card.pr);
      for (const identifier of profile.identifiers) add(`subtree_identifier:${domain}:${identifier}`, card.pr);
      for (const literal of profile.literals) add(`subtree_literal:${domain}:${literal}`, card.pr);
    }
    for (const literal of profile.literals) add(`literal:${literal}`, card.pr);
  }

  type MutableCandidate = Candidate & { signals: Set<string>; resources: Set<string> };
  const pairs = new Map<string, MutableCandidate>();
  const lexicalLimit = Math.max(6, Math.ceil(cards.length / 10));
  const literalLimit = Math.max(8, Math.ceil(cards.length / 5));
  for (const [posting, rawPrs] of postings) {
    const prs = [...new Set(rawPrs)].sort((a, b) => a - b);
    if (posting.startsWith("subtree_") && prs.length > lexicalLimit) continue;
    if (posting.startsWith("literal:") && prs.length > literalLimit) continue;
    for (let left = 0; left < prs.length; left++) for (let right = left + 1; right < prs.length; right++) {
      const a = prs[left], b = prs[right], key = `${a}:${b}`;
      const pair = pairs.get(key) ?? {
        a, b, sharedResources: [], joinReasons: [], candidateScore: 0, candidateTier: "weak" as const,
        candidateSources: ["lexical" as const], signals: new Set<string>(), resources: new Set<string>(),
      };
      pair.signals.add(posting.split(":", 1)[0]);
      pair.resources.add(posting);
      pairs.set(key, pair);
    }
  }

  for (const pair of pairs.values()) {
    const a = profiles.get(pair.a)!;
    const b = profiles.get(pair.b)!;
    const sharedFiles = [...a.files].filter((file) => b.files.has(file));
    const sharedDeclarations = [...a.declarations].filter((symbol) => b.declarations.has(symbol));
    const sharedIdentifiers = [...a.identifiers].filter((symbol) => b.identifiers.has(symbol));
    const sharedLiterals = [...a.literals].filter((literal) => b.literals.has(literal));
    let score = Math.min(14, sharedFiles.length ? 10 + sharedFiles.length - 1 : 0);
    score += Math.min(10, sharedDeclarations.length ? 7 + sharedDeclarations.length - 1 : 0);
    score += Math.min(6, sharedIdentifiers.length * 0.5);
    score += Math.min(4.5, sharedLiterals.length * 0.75);
    const sharedDomains = [...a.domains].filter((domain) => b.domains.has(domain));
    if (sharedDomains.some((domain) => domain.includes("/")) && (sharedIdentifiers.length || sharedLiterals.length)) score += 1;
    pair.candidateScore = Number(score.toFixed(3));
    pair.candidateTier = strongestTier(score, sharedFiles.length > 0, sharedDeclarations.length > 0);
    pair.evidenceStrength = pair.candidateTier === "strong" ? "strong" : pair.candidateTier === "medium" ? "medium" : "weak";
    pair.joinReasons = [
      ...(sharedFiles.length ? ["same_file"] : []),
      ...(sharedDeclarations.length ? ["same_declaration"] : []),
      ...(sharedIdentifiers.length ? ["bounded_subtree_identifier"] : []),
      ...(sharedLiterals.length ? ["shared_literal_or_config_key"] : []),
    ];
    pair.sharedResources = [
      ...sharedFiles.map((file) => `file:${file}`),
      ...sharedDeclarations.map((symbol) => `declaration:${symbol}`),
      ...sharedLiterals.map((literal) => `literal:${literal}`),
    ].slice(0, 24).sort();
    if (pair.sharedResources.length === 0) pair.sharedResources = [...pair.resources].slice(0, 12).sort();
  }

  const merged = new Map<string, Candidate>();
  for (const candidate of contractCandidates) {
    const key = `${candidate.a}:${candidate.b}`;
    merged.set(key, {
      ...candidate,
      candidateScore: Math.max(12, candidate.candidateScore ?? 0),
      candidateTier: "strong",
      candidateSources: ["contract"],
    });
  }
  for (const candidate of pairs.values()) {
    const key = `${candidate.a}:${candidate.b}`;
    const existing = merged.get(key);
    merged.set(key, existing ? {
      ...existing,
      sharedResources: [...new Set([...existing.sharedResources, ...candidate.sharedResources])].sort(),
      joinReasons: [...new Set([...(existing.joinReasons ?? []), ...(candidate.joinReasons ?? [])])].sort(),
      candidateScore: Math.max(existing.candidateScore ?? 0, candidate.candidateScore ?? 0),
      candidateTier: "strong",
      candidateSources: [...new Set([...(existing.candidateSources ?? []), "lexical" as const])],
    } : candidate);
  }
  const ranked = [...merged.values()].sort((left, right) => (right.candidateScore ?? 0) - (left.candidateScore ?? 0) || left.a - right.a || left.b - right.b);
  // Exact contract and same-file pairs are recall anchors. Lexical fallback is
  // degree-bounded so a popular subtree/token cannot recreate an n² graph.
  const pinned = ranked.filter((pair) => pair.candidateSources?.includes("contract") || pair.joinReasons?.includes("same_file"));
  const pinnedKeys = new Set(pinned.map((pair) => `${pair.a}:${pair.b}`));
  const degree = new Map<number, number>();
  for (const pair of pinned) {
    degree.set(pair.a, (degree.get(pair.a) ?? 0) + 1);
    degree.set(pair.b, (degree.get(pair.b) ?? 0) + 1);
  }
  const selected = [...pinned];
  const lexicalNeighborsPerPr = 8;
  for (const pair of ranked) {
    if (pinnedKeys.has(`${pair.a}:${pair.b}`)) continue;
    if ((degree.get(pair.a) ?? 0) >= lexicalNeighborsPerPr || (degree.get(pair.b) ?? 0) >= lexicalNeighborsPerPr) continue;
    selected.push(pair);
    degree.set(pair.a, (degree.get(pair.a) ?? 0) + 1);
    degree.set(pair.b, (degree.get(pair.b) ?? 0) + 1);
  }
  return selected.sort((left, right) => (right.candidateScore ?? 0) - (left.candidateScore ?? 0) || left.a - right.a || left.b - right.b);
}

function compatible(arity: number, min: number, max: number | null): boolean {
  return arity >= min && (max === null || arity <= max);
}

function signaturesOfChange(change: ContractFact): { before: Signature; after: Signature } {
  const [beforeEvidence, afterEvidence] = change.evidence.split(/\s+→\s+/, 2);
  const reparsedBefore = beforeEvidence ? parseDefinition(beforeEvidence, change.file)?.signature : undefined;
  const reparsedAfter = afterEvidence ? parseDefinition(afterEvidence, change.file)?.signature : undefined;
  return {
    before: reparsedBefore ?? {
      min: change.previousMinArity ?? change.previousArity ?? 0,
      max: change.previousMaxArity === undefined ? change.previousArity ?? null : change.previousMaxArity,
    },
    after: reparsedAfter ?? {
      min: change.minArity ?? change.arity,
      max: change.maxArity === undefined ? change.arity : change.maxArity,
    },
  };
}

function sharedKey(a: ContractFact, b: ContractFact): { key: string; strength: EvidenceStrength } | null {
  if (familyOf(a) !== familyOf(b)) return null;
  let best: { key: string; strength: EvidenceStrength } | null = null;
  for (const key of factKeys(a)) {
    if (!factKeys(b).includes(key)) continue;
    const strength = strengthFor(familyOf(a), key);
    if (!best || strengthRank[strength] > strengthRank[best.strength]) best = { key, strength };
  }
  return best;
}

export function judgeCandidates(cards: IntentCard[], candidates: Candidate[]): { conflicts: Conflict[]; needsVerification: VerificationFinding[] } {
  const byPr = new Map(cards.map((card) => [card.pr, card]));
  const conflicts: Conflict[] = [];
  const needsVerification: VerificationFinding[] = [];

  for (const candidate of candidates) {
    const a = byPr.get(candidate.a);
    const b = byPr.get(candidate.b);
    if (!a || !b) continue;
    const comparisons: Array<{ change: ContractFact; assumption: ContractFact; match: { key: string; strength: EvidenceStrength } }> = [];
    for (const left of a.facts) {
      for (const right of b.facts) {
        const change = isChange(left) && isAssumption(right) ? left : isAssumption(left) && isChange(right) ? right : undefined;
        const assumption = change === left ? right : change === right ? left : undefined;
        if (!change || !assumption) continue;
        const match = sharedKey(change, assumption);
        if (match) comparisons.push({ change, assumption, match });
      }
    }

    const surfaceComparisons: Array<{ left: ContractFact; right: ContractFact; match: { key: string; strength: EvidenceStrength } }> = [];
    for (const left of a.facts.filter((fact) => familyOf(fact) === "semantic_surface")) {
      for (const right of b.facts.filter((fact) => familyOf(fact) === "semantic_surface")) {
        const match = sharedKey(left, right);
        if (match) surfaceComparisons.push({ left, right, match });
      }
    }

    // Concurrent surface edits are candidates, not evidence by themselves.
    // Patch-level state/control interaction analysis below decides whether they
    // deserve expensive LLM or combined-runtime verification.
    if (surfaceComparisons.length > 0 && comparisons.length === 0) continue;

    let decided = false;
    for (const { change, assumption, match } of comparisons.sort((left, right) => strengthRank[right.match.strength] - strengthRank[left.match.strength])) {
      const family = familyOf(change);
      if (family === "api_arity") {
        const signatures = signaturesOfChange(change);
        const beforeMin = signatures.before.min;
        const beforeMax = signatures.before.max;
        const afterMin = signatures.after.min;
        const afterMax = signatures.after.max;
        if (!compatible(assumption.arity, beforeMin, beforeMax) || compatible(assumption.arity, afterMin, afterMax)) continue;
        const evidence = [`${change.file}: ${change.evidence}`, `${assumption.file}: ${assumption.evidence}`];
        const sharedFiles = a.files.filter((file) => b.files.includes(file));
        if (match.strength === "strong" && change.strictArity !== false && sharedFiles.length === 0) {
          conflicts.push({
            ...candidate,
            sharedResources: [match.key],
            evidenceStrength: "strong",
            verdict: "semantic_conflict",
            confidence: 1,
            evidenceLevel: "static_proof",
            rationale: `${change.symbol}의 허용 인자 범위가 ${beforeMin}..${beforeMax ?? "∞"}에서 ${afterMin}..${afterMax ?? "∞"}로 바뀌지만, 다른 PR은 이전 범위의 ${assumption.arity}개 인자 호출을 새로 추가합니다.`,
            evidence,
          });
        } else {
          const requiresPairMerge = sharedFiles.length > 0;
          needsVerification.push({
            ...candidate,
            sharedResources: [match.key],
            evidenceStrength: match.strength,
            verdict: "needs_verification",
            reasonCode: requiresPairMerge ? "pair_merge_required" : match.strength === "weak" ? "weak_symbol_identity" : "runtime_contract",
            rationale: requiresPairMerge
              ? `${change.symbol} 계약 불일치는 보이지만 두 PR이 ${sharedFiles.join(", ")} 파일을 함께 수정합니다. pair 간 텍스트 병합이 성공하는지 먼저 확인해야 합니다.`
              : `${change.symbol} 호출 계약 불일치 가능성이 있지만, 심볼 소유 모듈 또는 런타임 언어 동작을 병합 상태에서 확인해야 합니다.`,
            evidence,
          });
        }
        decided = true;
        break;
      }

      needsVerification.push({
        ...candidate,
        sharedResources: [match.key],
        evidenceStrength: match.strength,
        verdict: "needs_verification",
        reasonCode: "runtime_contract",
        rationale: family === "config_key"
          ? `${change.symbol} 설정 키가 교체되지만 다른 PR이 이전 키를 새로 읽습니다. 호환 별칭이나 fallback 존재 여부를 병합 상태에서 확인해야 합니다.`
          : `${change.symbol} 이벤트 채널이 교체되지만 다른 PR이 이전 채널을 새로 구독합니다. 이중 발행 또는 호환 listener 존재 여부를 병합 상태에서 확인해야 합니다.`,
        evidence: [`${change.file}: ${change.evidence}`, `${assumption.file}: ${assumption.evidence}`],
      });
      decided = true;
      break;
    }
    if (decided) continue;
  }
  return { conflicts, needsVerification };
}

export function analyze(prs: PullRequestInput[]): AnalysisResult {
  const pairMergeEligible = prs.filter((pr) => pr.mergeable);
  const excluded = prs
    .filter((pr) => !pr.mergeable)
    .map((pr) => ({ pr: pr.number, reason: "Git merge conflict" }));
  // CI is evidence about the baseline, not evidence about whether two PRs are
  // semantically related. Build semantic candidates for every individually
  // mergeable PR and defer attribution to the A/B/combined verifier.
  const cards = pairMergeEligible.map(extractIntentCard);
  const pairMergeCards = cards;
  const candidates = generateCandidates(cards);
  const semanticCandidates = generateBroadSemanticCandidates(cards, candidates);
  const gitCandidates = generateFileOverlapCandidates(pairMergeCards);
  const judgments = judgeCandidates(cards, candidates);
  const interactionFindings = judgeSemanticInteractions(pairMergeEligible, semanticCandidates);
  const ciByPr = new Map(pairMergeEligible.map((pr) => [pr.number, pr.ciPassed]));
  const hasVerifiedBaseline = (pair: Candidate) => ciByPr.get(pair.a) === true && ciByPr.get(pair.b) === true;
  const baselineFinding = (pair: Conflict | VerificationFinding): VerificationFinding => ({
    ...pair,
    verdict: "needs_verification",
    reasonCode: "ci_baseline_unverified",
    rationale: `${pair.rationale} 두 PR 중 하나 이상이 GitHub CI를 통과하지 않아 정적 결과만으로 충돌을 귀속하지 않습니다. A와 B가 각각 통과한 뒤 combined 결과를 비교해야 합니다.`,
  });
  const annotateUnverifiedBaseline = (pair: VerificationFinding): VerificationFinding => ({
    ...pair,
    rationale: `${pair.rationale} 두 PR 중 하나 이상이 GitHub CI를 통과하지 않았으므로 A/B 단독 실행이 모두 통과해야 이 상호작용을 충돌로 귀속할 수 있습니다.`,
  });
  const conflicts = judgments.conflicts.filter(hasVerifiedBaseline);
  const needsVerification = [
    ...judgments.conflicts.filter((pair) => !hasVerifiedBaseline(pair)).map(baselineFinding),
    ...judgments.needsVerification.map((pair) => hasVerifiedBaseline(pair) ? pair : annotateUnverifiedBaseline(pair)),
    ...interactionFindings.map((pair) => hasVerifiedBaseline(pair) ? pair : annotateUnverifiedBaseline(pair)),
  ];
  const strongSemanticPairs = semanticCandidates.filter((pair) => pair.candidateTier === "strong").length;
  const mediumSemanticPairs = semanticCandidates.filter((pair) => pair.candidateTier === "medium").length;
  const weakSemanticPairs = semanticCandidates.filter((pair) => pair.candidateTier === "weak").length;
  return {
    eligiblePrs: cards.length,
    pairMergePrs: pairMergeEligible.length,
    cards,
    pairMergeCards,
    candidates,
    semanticCandidates,
    gitCandidates,
    candidateSummary: {
      gitPairs: gitCandidates.length,
      contractPairs: candidates.length,
      broadSemanticPairs: semanticCandidates.length,
      strongSemanticPairs,
      mediumSemanticPairs,
      weakSemanticPairs,
    },
    conflicts,
    needsVerification,
    pairTextConflicts: [],
    excluded,
  };
}
