/**
 * Helper: snapshot a PR from GitHub REST API and print a GoldenCase JSON block.
 *
 * Usage:
 *   npm run export-seed -- 101471 "openclaw collision case"
 *   REPO=owner/repo npm run export-seed -- 42 "my note"
 *
 * Paste the output into seeds/golden-set.json (set expect + reasonIncludes manually).
 */
import 'dotenv/config';
import type { GoldenCase, RawPr } from './types.js';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.REPO ?? 'openclaw/openclaw';
const [OWNER, NAME] = REPO.split('/');

const prNumber = Number(process.argv[2]);
const note = process.argv[3] ?? `PR #${prNumber} snapshot`;

if (!TOKEN) {
  console.error('GITHUB_TOKEN is missing. Copy .env.example to .env and set it.');
  process.exit(1);
}
if (!Number.isFinite(prNumber)) {
  console.error('Usage: npm run export-seed -- <pr-number> [note]');
  process.exit(1);
}

async function fetchJson(url: string) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const pr = await fetchJson(`https://api.github.com/repos/${OWNER}/${NAME}/pulls/${prNumber}`);
  const files: Array<{ filename: string; additions: number; deletions: number }> = [];
  let page = 1;
  while (true) {
    const batch = await fetchJson(
      `https://api.github.com/repos/${OWNER}/${NAME}/pulls/${prNumber}/files?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    files.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  const raw: RawPr = {
    number: pr.number,
    title: pr.title,
    body: (pr.body ?? '').slice(0, 4000),
    isDraft: pr.draft,
    mergeable: pr.mergeable ? 'MERGEABLE' : pr.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    authorLogin: pr.user?.login ?? '(deleted)',
    authorIsBot: pr.user?.type === 'Bot',
    labels: (pr.labels ?? []).map((l: { name: string }) => l.name),
    files: files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions })),
    filesTruncated: false,
  };

  const seed: GoldenCase = {
    id: `pr-${prNumber}`,
    note,
    expect: 'pass',
    reasonIncludes: 'has_logic_files',
    pr: raw,
  };

  console.log(JSON.stringify(seed, null, 2));
  console.error('\nAdjust expect/reasonIncludes after reviewing classification.');
}

main().catch((err) => {
  console.error('Fatal:', err.message ?? err);
  process.exit(1);
});
