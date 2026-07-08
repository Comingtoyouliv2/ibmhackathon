/**
 * Step 0 / sub-step 1: fetch all open PRs from a repo via GitHub GraphQL.
 *
 * - Cursor pagination (PAGE_SIZE per request, default 50)
 * - Checkpoint resume: interrupt any time, rerun `npm run fetch` to continue
 * - Rate-limit aware: sleeps until reset when points run low
 * - Output: data/prs.jsonl (one PR per line), data/checkpoint.json
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import type { RawPr } from './types.js';

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('GITHUB_TOKEN is missing. Copy .env.example to .env and set it.');
  process.exit(1);
}
const REPO = process.env.REPO ?? 'openclaw/openclaw';
const [OWNER, NAME] = REPO.split('/');
const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 50);
const MAX_PRS = Number(process.env.MAX_PRS ?? Infinity);

const DATA_DIR = path.resolve('data');
const RAW_PATH = path.join(DATA_DIR, 'prs.jsonl');
const CKPT_PATH = path.join(DATA_DIR, 'checkpoint.json');

const QUERY = `
query($owner: String!, $name: String!, $pageSize: Int!, $cursor: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $pageSize, after: $cursor,
                 orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      pageInfo { endCursor hasNextPage }
      nodes {
        number title bodyText isDraft mergeable
        additions deletions changedFiles
        createdAt updatedAt
        author { login __typename }
        labels(first: 20) { nodes { name } }
        files(first: 100) { totalCount nodes { path additions deletions } }
      }
    }
  }
}`;

interface Checkpoint {
  cursor: string | null;
  count: number;
  done: boolean;
}

interface Page {
  prs: RawPr[];
  endCursor: string | null;
  hasNextPage: boolean;
  totalCount: number;
  rateRemaining: number;
  rateResetAt: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function slim(n: any): RawPr {
  return {
    number: n.number,
    title: n.title,
    body: (n.bodyText ?? '').slice(0, 4000),
    isDraft: n.isDraft,
    mergeable: n.mergeable,
    additions: n.additions,
    deletions: n.deletions,
    changedFiles: n.changedFiles,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    authorLogin: n.author?.login ?? '(deleted)',
    authorIsBot: n.author?.__typename === 'Bot',
    labels: (n.labels?.nodes ?? []).map((l: { name: string }) => l.name),
    files: (n.files?.nodes ?? []).map((f: { path: string; additions: number; deletions: number }) => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
    })),
    filesTruncated: (n.files?.totalCount ?? 0) > 100,
  };
}

async function fetchPage(cursor: string | null): Promise<Page> {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: QUERY,
          variables: { owner: OWNER, name: NAME, pageSize: PAGE_SIZE, cursor },
        }),
      });
      if (res.status === 502 || res.status === 503) throw new Error(`HTTP ${res.status} (transient)`);
      if (res.status === 403 || res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
        const waitMs = Math.max(reset - Date.now(), 60_000);
        console.warn(`Rate limited (HTTP ${res.status}). Sleeping ${Math.ceil(waitMs / 1000)}s...`);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

      const json = (await res.json()) as any;
      if (json.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(json.errors).slice(0, 500)}`);

      const prs = json.data.repository.pullRequests;
      return {
        prs: prs.nodes.map(slim),
        endCursor: prs.pageInfo.endCursor,
        hasNextPage: prs.pageInfo.hasNextPage,
        totalCount: prs.totalCount,
        rateRemaining: json.data.rateLimit.remaining,
        rateResetAt: json.data.rateLimit.resetAt,
      };
    } catch (err) {
      const cause = (err as { cause?: unknown })?.cause;
      const detail = cause ? ` / cause: ${String(cause)}` : '';
      if (attempt >= MAX_ATTEMPTS) throw err;
      const backoff = 2 ** attempt * 1000;
      console.warn(`Attempt ${attempt} failed (${(err as Error).message}${detail}). Retrying in ${backoff / 1000}s...`);
      await sleep(backoff);
    }
  }
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let cursor: string | null = null;
  let count = 0;
  if (fs.existsSync(CKPT_PATH)) {
    const ckpt: Checkpoint = JSON.parse(fs.readFileSync(CKPT_PATH, 'utf8'));
    if (ckpt.done) {
      console.log(`Fetch already complete (${ckpt.count} PRs). Delete data/checkpoint.json to refetch.`);
      return;
    }
    cursor = ckpt.cursor;
    count = ckpt.count;
    console.log(`Resuming from checkpoint: ${count} PRs already fetched.`);
  } else {
    fs.writeFileSync(RAW_PATH, ''); // fresh start
  }

  console.log(`Fetching open PRs from ${REPO} (page size ${PAGE_SIZE})...`);
  while (count < MAX_PRS) {
    const page = await fetchPage(cursor);
    if (page.prs.length > 0) {
      fs.appendFileSync(RAW_PATH, page.prs.map((p) => JSON.stringify(p)).join('\n') + '\n');
    }
    count += page.prs.length;
    cursor = page.endCursor;
    fs.writeFileSync(CKPT_PATH, JSON.stringify({ cursor, count, done: false } satisfies Checkpoint));
    console.log(`  ${count}/${page.totalCount} PRs  (rate remaining: ${page.rateRemaining})`);

    if (!page.hasNextPage) break;
    if (page.rateRemaining < 50) {
      const waitMs = Math.max(new Date(page.rateResetAt).getTime() - Date.now() + 5000, 0);
      console.warn(`Rate budget low. Sleeping ${Math.ceil(waitMs / 1000)}s until reset...`);
      await sleep(waitMs);
    }
    await sleep(300); // be polite; avoids secondary rate limits
  }

  fs.writeFileSync(CKPT_PATH, JSON.stringify({ cursor, count, done: true } satisfies Checkpoint));
  console.log(`Done. ${count} PRs written to ${RAW_PATH}`);
  console.log('Next: npm run step0');
}

main().catch((err) => {
  console.error('Fatal:', err.message ?? err);
  console.error('Progress is checkpointed — rerun `npm run fetch` to resume.');
  process.exit(1);
});
