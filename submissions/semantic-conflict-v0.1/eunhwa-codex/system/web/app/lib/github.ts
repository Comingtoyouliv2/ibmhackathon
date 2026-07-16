import { analyze, type AnalysisResult, type FileChange, type FileOperation, type PullRequestInput } from "./analyzer.ts";

export type RepositoryAnalysis = AnalysisResult & {
  repository: string;
  totalOpenPrs: number;
  scannedPrs: number;
  eligibleGatePrs: number;
  scanErrors: Array<{ pr: number; reason: string }>;
};

export type GatePr = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  headRefOid: string;
  baseRefOid: string;
  snapshotStale?: boolean;
  files?: { totalCount: number; nodes: Array<{ path: string }> };
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
};

type GraphPage = {
  data?: {
    rateLimit: { remaining: number; resetAt: string; cost: number };
    repository: {
      pullRequests: {
        totalCount: number;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: GatePr[];
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
};

const GATE_QUERY = `query($owner:String!,$name:String!,$cursor:String){
  rateLimit { remaining resetAt cost }
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN,first:100,after:$cursor,orderBy:{field:CREATED_AT,direction:DESC}){
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url isDraft mergeable headRefOid baseRefOid
        commits(last:1){nodes{commit{statusCheckRollup{state}}}}
      }
    }
  }
}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url: string, token?: string, init: RequestInit = {}): Promise<Response> {
  let lastError = "request failed";
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(60_000),
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
        cache: "no-store",
      });
      if (response.ok) return response;
      lastError = `GitHub API ${response.status}: ${(await response.text()).slice(0, 300)}`;
      if (![403, 429, 500, 502, 503, 504].includes(response.status)) throw new Error(lastError);
      const resetAt = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
      const rateDelay = exhausted && resetAt > Date.now() ? resetAt - Date.now() + 1_000 : 0;
      const retryAfter = Number(response.headers.get("retry-after") ?? 0) * 1_000;
      await sleep(Math.max(rateDelay, retryAfter, Math.min(8_000, 500 * 2 ** attempt)));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === 5) break;
      await sleep(Math.min(8_000, 500 * 2 ** attempt));
    }
  }
  throw new Error(lastError);
}

async function github<T>(url: string, token?: string, accept = "application/vnd.github+json"): Promise<T> {
  const response = await request(url, token, { headers: { Accept: accept } });
  return response.json() as Promise<T>;
}

async function graphPage(owner: string, name: string, cursor: string | null, token?: string): Promise<GraphPage> {
  const response = await request("https://api.github.com/graphql", token, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/vnd.github+json" },
    body: JSON.stringify({ query: GATE_QUERY, variables: { owner, name, cursor } }),
  });
  const page = await response.json() as GraphPage;
  if (page.errors?.length) throw new Error(`GitHub GraphQL: ${page.errors.map((error) => error.message).join("; ")}`);
  if (!page.data?.repository) throw new Error(`Repository not found: ${owner}/${name}`);
  return page;
}

async function fetchOpenPrGatePass(repository: string, token?: string, limit = Infinity): Promise<{ total: number; prs: GatePr[] }> {
  const [owner, name] = repository.split("/");
  const byNumber = new Map<number, GatePr>();
  let cursor: string | null = null;
  let reportedTotal = 0;
  do {
    const page = await graphPage(owner, name, cursor, token);
    const connection = page.data!.repository!.pullRequests;
    if (reportedTotal === 0) reportedTotal = connection.totalCount;
    for (const pr of connection.nodes) {
      if (byNumber.size >= limit) break;
      byNumber.set(pr.number, pr);
    }
    cursor = connection.pageInfo.hasNextPage && byNumber.size < limit ? connection.pageInfo.endCursor : null;
    const rate = page.data!.rateLimit;
    if (rate.remaining < 50) {
      await sleep(Math.max(0, new Date(rate.resetAt).getTime() - Date.now() + 1_000));
    }
  } while (cursor);
  // The connection can change while a long pagination pass is running. For an
  // all-open scan, the frozen unique number set is the only internally
  // consistent denominator; totalCount belongs to one page in a moving view.
  return { total: Number.isFinite(limit) ? reportedTotal : byNumber.size, prs: [...byNumber.values()] };
}

export function stabilizeGateSnapshot(first: GatePr[], second: GatePr[]): GatePr[] {
  const merged = new Map(first.map((pr) => [pr.number, pr]));
  for (const pr of second) {
    const previous = merged.get(pr.number);
    if (!previous) continue;
    if (previous.headRefOid !== pr.headRefOid) {
      merged.set(pr.number, { ...previous, mergeable: "UNKNOWN", snapshotStale: true });
      continue;
    }
    if (previous.mergeable === "UNKNOWN" || pr.mergeable !== "UNKNOWN") {
      merged.set(pr.number, { ...pr, baseRefOid: previous.baseRefOid, headRefOid: previous.headRefOid });
    }
  }
  return [...merged.values()];
}

async function fetchAllOpenPrGates(repository: string, token?: string, limit = Infinity): Promise<{ total: number; prs: GatePr[] }> {
  const first = await fetchOpenPrGatePass(repository, token, limit);
  if (!first.prs.some((pr) => pr.mergeable === "UNKNOWN")) return first;
  await sleep(1_000);
  const second = await fetchOpenPrGatePass(repository, token, limit);
  return { total: first.total, prs: stabilizeGateSnapshot(first.prs, second.prs) };
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

type GitHubFile = { filename: string; previous_filename?: string; status?: string; patch?: string };

async function allFiles(root: string, pr: number, token?: string): Promise<GitHubFile[]> {
  const files: GitHubFile[] = [];
  for (let page = 1; ; page++) {
    const batch = await github<GitHubFile[]>(`${root}/pulls/${pr}/files?per_page=100&page=${page}`, token);
    files.push(...batch);
    if (batch.length < 100) return files;
  }
}

function normalizeOperation(status?: string): FileOperation {
  return new Set<FileOperation>(["added", "modified", "removed", "renamed", "copied", "changed"]).has(status as FileOperation)
    ? status as FileOperation
    : "unknown";
}

function changesFromRows(rows: GitHubFile[]): FileChange[] {
  return rows.map((file) => ({ path: file.filename, previousPath: file.previous_filename, operation: normalizeOperation(file.status) }));
}

async function fetchDiff(root: string, pr: number, token?: string): Promise<{ diff: string; files: string[]; fileChanges: FileChange[] }> {
  const fileRows = await allFiles(root, pr, token);
  // The paginated files endpoint already contains each text patch. Reusing it
  // avoids a second REST request per PR, which is essential for all-open scans
  // to stay within GitHub's hourly rate limit. Binary or oversized patches are
  // still represented by file metadata and remain eligible for Git path checks.
  return {
    files: fileRows.map((file) => file.filename),
    fileChanges: changesFromRows(fileRows),
    diff: fileRows.map((file) => `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch ?? ""}`).join("\n"),
  };
}

function pairMergeGateReason(pr: GatePr): string | null {
  if (pr.snapshotStale) return "PR updated during scan";
  if (pr.isDraft) return "Draft PR";
  if (pr.mergeable === "CONFLICTING") return "Git merge conflict";
  // UNKNOWN is admitted provisionally. The verifier accepts it only when the
  // exact GitHub synthetic merge ref exists and still matches the frozen head.
  return null;
}

function ciStatus(pr: GatePr): "passed" | "failed" | "pending" | "missing" {
  const state = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
  if (!state) return "missing";
  if (state === "SUCCESS") return "passed";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return "failed";
}

function semanticGateReason(pr: GatePr): string | null {
  const pairReason = pairMergeGateReason(pr);
  if (pairReason) return pairReason;
  return ciStatus(pr) === "passed" ? null : "CI not passed";
}

export async function analyzeRepository(repository: string, token?: string, limit = Infinity): Promise<RepositoryAnalysis> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Repository must be owner/name");
  const root = `https://api.github.com/repos/${repository}`;
  const { total, prs } = await fetchAllOpenPrGates(repository, token, limit);
  const excluded = prs.flatMap((pr) => {
    const reason = pairMergeGateReason(pr);
    return reason ? [{ pr: pr.number, reason }] : [];
  });
  const eligible = prs.filter((pr) => semanticGateReason(pr) === null);
  const pairMergeEligible = prs.filter((pr) => pairMergeGateReason(pr) === null);
  const scanErrors: Array<{ pr: number; reason: string }> = [];
  let loadedCount = 0;
  const loaded = await mapConcurrent(pairMergeEligible, 3, async (pr): Promise<PullRequestInput | null> => {
    try {
      const status = ciStatus(pr);
      // Failed, pending, and missing CI are still valid semantic candidates.
      // Their CI state is retained for attribution, while their actual patch is
      // loaded so cross-file contracts and interactions are not silently lost.
      const loadedChange = await fetchDiff(root, pr.number, token);
      const input = {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        headSha: pr.headRefOid,
        baseSha: pr.baseRefOid,
        ciPassed: status === "passed",
        ciStatus: status,
        mergeable: true,
        files: loadedChange.files,
        fileChanges: loadedChange.fileChanges,
        diff: loadedChange.diff,
      };
      loadedCount++;
      if (loadedCount % 100 === 0 || loadedCount === pairMergeEligible.length) {
        console.log(`  ${repository}: loaded ${loadedCount}/${pairMergeEligible.length} PR diffs`);
      }
      return input;
    } catch (error) {
      scanErrors.push({ pr: pr.number, reason: error instanceof Error ? error.message : String(error) });
      return null;
    }
  });
  const validation = await fetchOpenPrGatePass(repository, token, limit);
  const finalSnapshot = new Map(validation.prs.map((pr) => [pr.number, pr]));
  const inputs = loaded.filter((pr): pr is PullRequestInput => {
    if (!pr) return false;
    const current = finalSnapshot.get(pr.number);
    if (current && current.headRefOid === pr.headSha && current.baseRefOid === pr.baseSha) return true;
    scanErrors.push({ pr: pr.number, reason: "PR base/head changed during scan; snapshot discarded" });
    return false;
  });
  const analysis = analyze(inputs);
  return {
    repository,
    totalOpenPrs: total,
    scannedPrs: prs.length,
    eligibleGatePrs: eligible.length,
    pairMergeGatePrs: pairMergeEligible.length,
    scanErrors,
    ...analysis,
    excluded,
  };
}
