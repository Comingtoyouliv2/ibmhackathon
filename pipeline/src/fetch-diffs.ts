/**
 * Optional evidence collection for Step 1. GitHub's GraphQL Step 0 query has
 * filenames but no patches; this fetches REST file patches only for passed PRs.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, writeJsonl } from './io.js';
import type { PrDiff, RawPr } from './types.js';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.REPO ?? 'openclaw/openclaw';
const [OWNER, NAME] = REPO.split('/');
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const PASSED_PATH = path.join(DATA_DIR, 'passed.jsonl');
const OUT_PATH = path.join(DATA_DIR, 'pr-diffs.jsonl');
const DIFF_CONCURRENCY = Math.max(1, Number(process.env.DIFF_CONCURRENCY ?? 8));

if (!TOKEN) {
  console.error('GITHUB_TOKEN is missing. Copy .env.example to .env and set it.');
  process.exit(1);
}

interface ApiFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed';
  previous_filename?: string;
  patch?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url: string): Promise<Response> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    if (response.ok) return response;
    const detail = `HTTP ${response.status}: ${await response.text()}`;
    if (response.status >= 500 && attempt < 4) {
      console.warn(`${detail.slice(0, 180)}; retrying (${attempt}/4).`);
      await sleep(attempt * 1_000);
      continue;
    }
    throw new Error(detail);
  }
  throw new Error('unreachable');
}

async function fetchOne(pr: number): Promise<PrDiff> {
  const files: PrDiff['files'] = [];
  for (let page = 1; ; page++) {
    const response = await request(`https://api.github.com/repos/${OWNER}/${NAME}/pulls/${pr}/files?per_page=100&page=${page}`);
    const rows = (await response.json()) as ApiFile[];
    for (const row of rows) {
      files.push({
        path: row.filename,
        status: row.status,
        previousPath: row.previous_filename,
        patch: row.patch,
        // GitHub omits patch for binary files and oversized diffs.
        patchTruncated: !row.patch,
      });
    }
    if (rows.length < 100) break;
  }
  return { pr, files, fetchedAt: new Date().toISOString() };
}

async function main(): Promise<void> {
  const passed = readJsonl<RawPr>(PASSED_PATH);
  if (!fs.existsSync(PASSED_PATH)) throw new Error('data/passed.jsonl not found. Run Step 0 first.');
  if (!passed.length) { writeJsonl(OUT_PATH, []); console.log('No Step 0 pass PRs; wrote an empty diff cache.'); return; }
  const existing = new Map(readJsonl<PrDiff>(OUT_PATH).map((row) => [row.pr, row]));
  const todo = passed.filter((pr) => !existing.has(pr.number));
  console.log(`Diff evidence: ${existing.size}/${passed.length} cached; fetching ${todo.length} with concurrency ${DIFF_CONCURRENCY}.`);
  let next = 0;
  let completed = 0;
  async function worker(): Promise<void> {
    while (next < todo.length) {
      const pr = todo[next++];
      try {
        existing.set(pr.number, await fetchOne(pr.number));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Skipping diff for #${pr.number}: ${message.slice(0, 240)}`);
        existing.set(pr.number, { pr: pr.number, files: [], fetchedAt: new Date().toISOString(), error: message.slice(0, 1_000) });
      }
      completed++;
      if (completed % 25 === 0 || completed === todo.length) {
        writeJsonl(OUT_PATH, [...existing.values()].sort((a, b) => a.pr - b.pr));
        console.log(`  ${completed}/${todo.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DIFF_CONCURRENCY, todo.length) }, worker));
}

main().catch((error) => {
  console.error('Fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
