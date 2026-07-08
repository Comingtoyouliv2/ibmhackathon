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
