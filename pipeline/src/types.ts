/** Shared types for the Step 0 pipeline. */

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

/** One PR as stored in data/prs.jsonl (slimmed from the GraphQL response). */
export interface RawPr {
  number: number;
  title: string;
  body: string; // truncated to 4000 chars
  isDraft: boolean;
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  authorLogin: string;
  authorIsBot: boolean;
  labels: string[];
  files: PrFile[];
  /** true if the PR has >100 changed files and the list was truncated */
  filesTruncated: boolean;
}

/**
 * Diff text collected separately from the lightweight Step 0 fetch.  Keeping
 * this out of RawPr lets Step 0 stay cheap while later stages can opt into the
 * evidence they need.
 */
export interface PrDiff {
  pr: number;
  files: Array<{
    path: string;
    status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed';
    previousPath?: string;
    patch?: string;
    patchTruncated: boolean;
  }>;
  fetchedAt: string;
  /** Present when GitHub could not provide this PR's diff after retries. */
  error?: string;
}

export type FileClass = 'docs' | 'test' | 'deps' | 'config' | 'assets' | 'logic';

export type Verdict = 'pass' | 'excluded' | 'deferred';

/** How strong the logic-change signal is (for Step 1 prioritization). */
export type SignalStrength = 'high' | 'low' | 'unknown';

/** One PR as stored in data/step0.jsonl — the contract consumed by Step 1. */
export interface Step0Result {
  pr: number;
  title: string;
  verdict: Verdict;
  /** Stable code for aggregation (e.g. has_logic_files, no_logic_files(docs)). */
  reason: string;
  /** Human-readable detail (line counts etc.) — not for aggregation. */
  reasonDetail: string;
  fileClasses: Partial<Record<FileClass, number>>;
  logicFileCount: number;
  logicChangeLines: number;
  totalChangeLines: number;
  signalStrength: SignalStrength;
  isDraft: boolean;
  authorLogin: string;
  authorIsBot: boolean;
  updatedAt: string;
}

/** A resource through which two independently valid PRs can interact. */
export interface TouchedResource {
  /** Canonical, repository-local key, e.g. `file:src/agents/session`. */
  key: string;
  /** Broad kind makes later LLM output stable without forcing global domains. */
  kind: 'file' | 'module' | 'config' | 'api' | 'schema' | 'event' | 'state' | 'symbol' | 'issue';
  /** Whether this PR mostly reads, writes, removes, or changes a contract. */
  operation: 'read' | 'write' | 'remove' | 'contract_change' | 'unknown';
  evidence: string[];
  confidence: number;
}

export interface SectorAssignment {
  sector: string;
  score: number;
  evidence: string[];
}

export interface SectorCard {
  pr: number;
  title: string;
  sectors: SectorAssignment[];
}

/** One repository-local responsibility selected inside a coarse sector. */
export interface HierarchyAssignment {
  sector: string;
  domain: string;
  /** Optional: populated only when the selected responsibility has a useful finer boundary. */
  subDomain?: string;
  evidence: string[];
  confidence: number;
}

/**
 * Step 1 output. `domains` are deliberately repository-local scopes; they
 * are candidate-generation hints, not a universal taxonomy across repos.
 */
export interface IntentCard {
  pr: number;
  title: string;
  summary: string;
  /** Kept as a flattened compatibility field for reports and Bob prompts. */
  domains: string[];
  sectors: string[];
  hierarchy: HierarchyAssignment[];
  touchedResources: TouchedResource[];
  assumptions: string[];
  behaviorChanges: Array<{ surface: string; before: string; after: string }>;
  /** Explicit PR relations found in authored text, e.g. "Stacked on #123". */
  dependencies: Array<{ pr: number; relation: 'stacked_on' | 'depends_on' | 'related' }>;
  evidenceQuality: 'diff' | 'metadata_only';
  confidence: number;
  extractor: 'heuristic-v1' | 'heuristic-v2' | 'bob';
}

export interface CandidatePair {
  prA: number;
  prB: number;
  score: number;
  reasons: Array<{ signal: string; detail: string; weight: number }>;
  sharedResources: string[];
  sharedSectors: string[];
  sharedDomains: string[];
  sharedSubDomains: string[];
  relation: 'independent' | 'explicit_dependency';
  selectionStage: 'small_sector' | 'resource' | 'domain_resource' | 'dependency';
  /** Review hypotheses, not a semantic-conflict verdict. */
  potentialConflicts: string[];
  status: 'needs_review';
}

/**
 * A bounded, self-contained handoff unit for a human reviewer or IBM Bob.
 * It is intentionally unreviewed: candidate generation is not a verdict.
 */
export interface ReviewPacket {
  id: string;
  repo: string;
  candidate: CandidatePair;
  prA: IntentCard;
  prB: IntentCard;
  evidence: {
    sharedResources: string[];
    sharedSectors: string[];
    sharedDomains: string[];
    sharedSubDomains: string[];
    diffExcerpts: Array<{
      pr: number;
      path: string;
      status: PrDiff['files'][number]['status'];
      patchExcerpt?: string;
      patchTruncated: boolean;
    }>;
  };
  reviewInstructions: {
    objective: string;
    questions: string[];
    verdicts: Array<'conflict' | 'no_conflict' | 'uncertain'>;
  };
  status: 'unreviewed';
}

/** The result format expected when Bob (or a human) reviews a packet. */
export interface PairReview {
  packetId: string;
  prA: number;
  prB: number;
  verdict: 'conflict' | 'no_conflict' | 'uncertain';
  confidence: number;
  summary: string;
  evidence: string[];
  followUp: string[];
  reviewer: 'bob' | 'human';
  reviewedAt: string;
}

/** Manually labelled pair used to evaluate candidate recall on closed PR snapshots. */
export interface PairLabel {
  prA: number;
  prB: number;
  expected: 'review' | 'ignore';
  verdict?: 'conflict' | 'no_conflict' | 'dependency' | 'uncertain';
  note?: string;
}

/** Optional snapshot metadata stored next to closed-PR evaluation labels. */
export interface EvaluationUniverse {
  repo: string;
  snapshot: string;
  eligiblePrs: number[];
}

/** Golden-set regression case — frozen PR snapshot, survives merge/close. */
export interface GoldenCase {
  id: string;
  note: string;
  expect: Verdict;
  /** Optional substring the reason must contain. */
  reasonIncludes?: string;
  pr: RawPr;
}

export interface GoldenSet {
  version: number;
  note: string;
  cases: GoldenCase[];
}
