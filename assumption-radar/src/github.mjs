import { summarizeCommitChecks } from "./pr-eligibility.mjs";

const API = "https://api.github.com";

function headers(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "assumption-radar",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request(path, token) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${API}${path}`, { headers: headers(token) });
    if (response.ok) return response.json();
    const detail = await response.text();
    const error = new Error(`GitHub API ${response.status}: ${detail.slice(0, 240)}`);
    error.status = response.status;
    lastError = error;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
  }
  throw lastError;
}

function requestedLimit(options = {}) {
  return Math.max(2, Math.min(1_000, Number(options.limit) || 100));
}

async function listOpenPullRequests(repo, token, options = {}) {
  const limit = requestedLimit(options);
  const pulls = [];
  for (let page = 1; pulls.length < limit; page += 1) {
    const perPage = Math.min(100, limit - pulls.length);
    const batch = await request(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${perPage}&page=${page}`, token);
    pulls.push(...batch);
    if (batch.length < perPage) break;
  }
  return pulls.slice(0, limit);
}

async function listMergedPullRequests(repo, token, options = {}) {
  const limit = Math.max(2, Math.min(500, Number(options.limit) || 100));
  const merged = [];
  for (let page = 1; merged.length < limit && page <= 20; page += 1) {
    const batch = await request(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`, token);
    merged.push(...batch.filter((pr) => pr.merged_at));
    if (batch.length < 100) break;
  }
  return merged
    .sort((a, b) => new Date(b.merged_at) - new Date(a.merged_at))
    .slice(0, limit);
}

export function parseRepository(value) {
  const cleaned = String(value || "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(cleaned)) throw new Error("저장소는 owner/repo 또는 GitHub URL 형식이어야 합니다.");
  return cleaned;
}

async function fetchFiles(repo, number, token) {
  const files = [];
  for (let page = 1; page <= 4; page += 1) {
    const batch = await request(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, token);
    files.push(...batch.map((file) => ({
      filename: file.filename,
      previousFilename: file.previous_filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: file.patch || "",
      url: file.blob_url,
    })));
    if (batch.length < 100) break;
  }
  return files;
}

export async function fetchCommitChecks(repo, sha, token) {
  const unknown = (lookup = "unavailable") => ({
    status: "unknown", totalChecks: 0, failedChecks: [], pendingChecks: [], inconclusiveChecks: [], legacyStatus: null, lookup,
  });
  if (!sha) return unknown("missing-head-sha");
  try {
    const [checks, status] = await Promise.all([
      request(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`, token),
      request(`/repos/${repo}/commits/${sha}/status?per_page=100`, token),
    ]);
    return { ...summarizeCommitChecks(checks.check_runs || [], status), lookup: "available" };
  } catch (error) {
    // CI metadata is an optimization, not the source of truth. Repositories
    // without check-run permission must still reach the Base/A/B verifier.
    if ([403, 404, 422].includes(error.status)) return unknown();
    throw error;
  }
}

export async function fetchOpenPullRequests(repository, token = process.env.GITHUB_TOKEN, options = {}) {
  const repo = parseRepository(repository);
  const pulls = await listOpenPullRequests(repo, token, options);
  const hydrated = [];
  const queue = [...pulls];
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    while (queue.length) {
      const pr = queue.shift();
      const [details, files, ci] = await Promise.all([
        request(`/repos/${repo}/pulls/${pr.number}`, token),
        fetchFiles(repo, pr.number, token),
        options.includeCiStatus ? fetchCommitChecks(repo, pr.head?.sha, token) : null,
      ]);
      hydrated.push({
        id: String(pr.id), number: pr.number, title: pr.title, body: pr.body || "",
        author: pr.user?.login || "unknown", url: pr.html_url, head: pr.head?.ref, headSha: pr.head?.sha,
        base: pr.base?.ref, baseSha: pr.base?.sha, draft: Boolean(pr.draft), updatedAt: pr.updated_at, additions: details.additions,
        deletions: details.deletions, files,
        ...(ci ? { ci } : {}),
      });
    }
  });
  await Promise.all(workers);
  return hydrated.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function fetchOpenPullRequestMetadata(repository, token = process.env.GITHUB_TOKEN, options = {}) {
  const repo = parseRepository(repository);
  const pulls = await listOpenPullRequests(repo, token, options);
  return pulls.map((pr) => ({
    id: String(pr.id),
    number: pr.number,
    updatedAt: pr.updated_at,
    head: pr.head?.ref,
    headSha: pr.head?.sha,
    base: pr.base?.ref,
    baseSha: pr.base?.sha,
  }));
}

export async function fetchMergedPullRequests(repository, token = process.env.GITHUB_TOKEN, options = {}) {
  const repo = parseRepository(repository);
  const pulls = await listMergedPullRequests(repo, token, options);
  const hydrated = [];
  const queue = [...pulls];
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    while (queue.length) {
      const pr = queue.shift();
      const files = await fetchFiles(repo, pr.number, token);
      hydrated.push({
        id: String(pr.id), number: pr.number, title: pr.title, body: pr.body || "",
        author: pr.user?.login || "unknown", url: pr.html_url,
        head: pr.head?.ref, headSha: pr.head?.sha,
        base: pr.base?.ref, baseSha: pr.base?.sha,
        mergeCommitSha: pr.merge_commit_sha || null,
        mergedAt: pr.merged_at, closedAt: pr.closed_at, updatedAt: pr.updated_at,
        files,
      });
    }
  });
  await Promise.all(workers);
  return hydrated.sort((a, b) => new Date(b.mergedAt) - new Date(a.mergedAt));
}

export async function fetchPullRequest(repository, number, token = process.env.GITHUB_TOKEN) {
  const repo = parseRepository(repository);
  const pr = await request(`/repos/${repo}/pulls/${Number(number)}`, token);
  return {
    id: String(pr.id), number: pr.number, title: pr.title, body: pr.body || "",
    author: pr.user?.login || "unknown", url: pr.html_url,
    head: pr.head?.ref, headSha: pr.head?.sha,
    base: pr.base?.ref, baseSha: pr.base?.sha,
    mergeCommitSha: pr.merge_commit_sha || null,
    createdAt: pr.created_at, mergedAt: pr.merged_at, closedAt: pr.closed_at, updatedAt: pr.updated_at,
    files: [],
  };
}

export async function fetchPullRequestsForCommit(repository, sha, token = process.env.GITHUB_TOKEN) {
  const repo = parseRepository(repository);
  const pulls = await request(`/repos/${repo}/commits/${sha}/pulls`, token);
  return pulls.filter((pr) => pr.merged_at).map((pr) => ({
    id: String(pr.id), number: pr.number, title: pr.title, body: pr.body || "",
    author: pr.user?.login || "unknown", url: pr.html_url,
    head: pr.head?.ref, headSha: pr.head?.sha,
    base: pr.base?.ref, baseSha: pr.base?.sha,
    mergeCommitSha: pr.merge_commit_sha || null,
    createdAt: pr.created_at, mergedAt: pr.merged_at, closedAt: pr.closed_at, updatedAt: pr.updated_at,
    files: [],
  }));
}

export async function fetchIssue(repository, number, token = process.env.GITHUB_TOKEN) {
  const repo = parseRepository(repository);
  const issue = await request(`/repos/${repo}/issues/${Number(number)}`, token);
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body || "",
    url: issue.html_url,
    state: issue.state,
    createdAt: issue.created_at,
    closedAt: issue.closed_at,
    isPullRequest: Boolean(issue.pull_request),
    labels: (issue.labels || []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean),
  };
}
