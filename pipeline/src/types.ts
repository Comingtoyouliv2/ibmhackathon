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

/** One PR as stored in data/step0.jsonl — the contract consumed by Step 1. */
export interface Step0Result {
  pr: number;
  title: string;
  verdict: Verdict;
  reason: string;
  fileClasses: Partial<Record<FileClass, number>>;
  isDraft: boolean;
  authorLogin: string;
  authorIsBot: boolean;
  updatedAt: string;
}
