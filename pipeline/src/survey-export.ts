/**
 * Survey export: condense data/prs.jsonl into one line per PR
 * (#number|title|top dirs) so an entire repo's open PR set fits in a
 * single LLM session for domain/resource vocabulary discovery.
 *
 * Usage:  REPO=owner/repo npm run survey-export
 * Reads   data/prs.jsonl (from `npm run fetch`)
 * Writes  data/survey_<repo>_allPR.txt
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import type { RawPr } from './types.js';

const REPO = process.env.REPO ?? 'openclaw/openclaw';
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const RAW_PATH = path.join(DATA_DIR, 'prs.jsonl');

function main() {
  if (!fs.existsSync(RAW_PATH)) {
    console.error('data/prs.jsonl not found. Run `npm run fetch` first.');
    process.exit(1);
  }
  const byNumber = new Map<number, RawPr>();
  for (const line of fs.readFileSync(RAW_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const pr: RawPr = JSON.parse(line);
    byNumber.set(pr.number, pr);
  }
  const rows = [...byNumber.values()].sort((a, b) => a.number - b.number);

  const lines = rows.map((r) => {
    const dirs: string[] = [];
    for (const f of r.files) {
      const parts = f.path.split('/');
      const key = parts.length > 1 ? parts.slice(0, 2).join('/') : parts[0];
      if (!dirs.includes(key)) dirs.push(key);
    }
    return `#${r.number}|${r.title.slice(0, 90)}|${dirs.slice(0, 4).join(',')}`;
  });

  const short = REPO.split('/')[1] ?? REPO;
  const outPath = path.join(DATA_DIR, `survey_${short}_allPR.txt`);
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`Wrote ${outPath} (${lines.length} PRs)`);
}

main();
