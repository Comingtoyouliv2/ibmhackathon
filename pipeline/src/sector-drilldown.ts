/** Explain sector -> domain -> sub-domain -> touched-resource reduction. */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, writeJsonl } from './io.js';
import type { IntentCard } from './types.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const SECTOR = process.env.SECTOR ?? 'core:agents';
const CARD_PATH = path.join(DATA_DIR, 'intent-cards.jsonl');
const SAFE_NAME = SECTOR.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
const OUT_JSON = path.join(DATA_DIR, `sector-drilldown-${SAFE_NAME}.jsonl`);
const OUT_MD = path.join(DATA_DIR, `sector-drilldown-${SAFE_NAME}.md`);

interface Bucket {
  domain: string;
  subDomain: string;
  prs: number[];
  sharedResources: Array<{ resource: string; prs: number[] }>;
  candidatePairs: number;
}

function pairKey(a: number, b: number): string { return a < b ? `${a}:${b}` : `${b}:${a}`; }

function main(): void {
  const cards = readJsonl<IntentCard>(CARD_PATH).filter((card) => card.sectors.includes(SECTOR));
  if (!cards.length) throw new Error(`No intent cards for ${SECTOR}. Run sectors and intent first.`);
  const groups = new Map<string, IntentCard[]>();
  for (const card of cards) {
    const assignment = card.hierarchy.find((entry) => entry.sector === SECTOR);
    if (!assignment) continue;
    const key = `${assignment.domain}\t${assignment.subDomain ?? 'unclassified'}`;
    const rows = groups.get(key) ?? [];
    rows.push(card);
    groups.set(key, rows);
  }
  const output: Bucket[] = [];
  for (const [key, rows] of groups) {
    const [domain, subDomain] = key.split('\t');
    const resources = new Map<string, Set<number>>();
    for (const card of rows) for (const resource of card.touchedResources) {
      const prs = resources.get(resource.key) ?? new Set<number>();
      prs.add(card.pr);
      resources.set(resource.key, prs);
    }
    const sharedResources = [...resources.entries()]
      .map(([resource, prs]) => ({ resource, prs: [...prs].sort((a, b) => a - b) }))
      .filter((bucket) => bucket.prs.length >= 2)
      .sort((a, b) => b.prs.length - a.prs.length || a.resource.localeCompare(b.resource));
    const pairs = new Set<string>();
    for (const bucket of sharedResources) for (let i = 0; i < bucket.prs.length; i++) for (let j = i + 1; j < bucket.prs.length; j++) pairs.add(pairKey(bucket.prs[i], bucket.prs[j]));
    output.push({ domain, subDomain, prs: rows.map((card) => card.pr).sort((a, b) => a - b), sharedResources, candidatePairs: pairs.size });
  }
  output.sort((a, b) => b.prs.length - a.prs.length || a.domain.localeCompare(b.domain) || a.subDomain.localeCompare(b.subDomain));
  writeJsonl(OUT_JSON, output);
  const allPairs = cards.length * (cards.length - 1) / 2;
  const candidatePairs = output.reduce((sum, bucket) => sum + bucket.candidatePairs, 0);
  const lines = [
    `# Sector Drill-down — ${SECTOR}`,
    '',
    `- PRs: **${cards.length}**`,
    `- All pairs inside sector: **${allPairs}**`,
    `- Domain/sub-domain buckets: **${output.length}**`,
    `- Candidate pair occurrences after shared-resource filter: **${candidatePairs}**`,
    '',
    '| domain | sub-domain | PRs | shared resource buckets | candidate pairs | largest resource bucket |',
    '|---|---|---:|---:|---:|---:|',
    ...output.map((bucket) => `| ${bucket.domain} | ${bucket.subDomain} | ${bucket.prs.length} | ${bucket.sharedResources.length} | ${bucket.candidatePairs} | ${bucket.sharedResources[0]?.prs.length ?? 0} |`),
    '',
    '> A PR may belong to several sectors, but it has one selected domain/sub-domain per sector. Candidate generation still requires a shared concrete resource.',
    '',
  ];
  fs.writeFileSync(OUT_MD, lines.join('\n'));
  console.log(`Wrote ${OUT_JSON} and ${OUT_MD}: ${cards.length} PRs -> ${output.length} hierarchy buckets.`);
}

main();
