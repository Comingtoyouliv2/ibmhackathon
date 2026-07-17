/**
 * Build small, repository-local PR sectors without requiring labels to exist.
 * Labels improve confidence when a repository provides them; changed-file
 * boundaries remain the universal fallback.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, writeJsonl } from './io.js';
import type { RawPr, SectorAssignment, SectorCard } from './types.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const IN_PATH = path.join(DATA_DIR, 'passed.jsonl');
const OUT_PATH = path.join(DATA_DIR, 'sectors.jsonl');
const REPORT_PATH = path.join(DATA_DIR, 'sector-report.md');
const MAX_SECTORS_PER_PR = Number(process.env.MAX_SECTORS_PER_PR ?? 3);

function add(out: Map<string, SectorAssignment>, sector: string, score: number, evidence: string): void {
  const current = out.get(sector) ?? { sector, score: 0, evidence: [] };
  current.score += score;
  if (!current.evidence.includes(evidence)) current.evidence.push(evidence);
  out.set(sector, current);
}

function sectorFromLabel(label: string): string | undefined {
  const normalized = label.toLowerCase().trim();
  const scoped = normalized.match(/^(channel|extensions?|app):\s*(.+)$/);
  if (scoped) {
    const kind = scoped[1].startsWith('extension') ? 'extension' : scoped[1];
    return `${kind}:${scoped[2].replace(/\s+/g, '-')}`;
  }
  const core = new Set(['agents', 'gateway', 'commands', 'cli', 'security']);
  return core.has(normalized) ? `core:${normalized}` : undefined;
}

function sectorFromPath(filePath: string): string | undefined {
  const parts = filePath.split('/');
  if (/(^|\/)(?:docs?|test|tests|fixtures|snapshots?|__tests__)(\/|$)|\.(?:test|spec|fixture)\.[^/]+$|\.(?:md|snap)$/i.test(filePath)) return undefined;
  if (parts[0] === 'extensions' && parts[1]) return `extension:${parts[1]}`;
  if (parts[0] === 'apps' && parts[1]) return `app:${parts[1]}`;
  if (parts[0] === 'packages' && parts[1]) return `package:${parts[1]}`;
  if (parts[0] === 'src' && parts[1]) return `core:${parts[1]}`;
  if (parts[0] === 'ui') return 'app:web-ui';
  if (parts[0] === '.github' || parts[0] === 'scripts') return 'delivery:ci';
  if (parts[0] === 'skills') return 'core:skills';
  if (parts.length > 1 && parts[0]) return `component:${parts[0]}`;
  return 'root:repository';
}

function cardFor(pr: RawPr): SectorCard {
  const candidates = new Map<string, SectorAssignment>();
  for (const label of pr.labels) {
    const sector = sectorFromLabel(label);
    if (sector) add(candidates, sector, 6, `label:${label}`);
  }
  for (const file of pr.files) {
    const sector = sectorFromPath(file.path);
    if (sector) add(candidates, sector, 1, `path:${file.path}`);
  }
  return {
    pr: pr.number,
    title: pr.title,
    sectors: [...candidates.values()]
      .sort((a, b) => b.score - a.score || a.sector.localeCompare(b.sector))
      .slice(0, MAX_SECTORS_PER_PR)
      .map((entry) => ({ ...entry, score: Number(entry.score.toFixed(2)), evidence: entry.evidence.slice(0, 4) })),
  };
}

function main(): void {
  const prs = readJsonl<RawPr>(IN_PATH);
  if (!fs.existsSync(IN_PATH)) throw new Error('data/passed.jsonl not found. Run Step 0 first.');
  if (!prs.length) {
    writeJsonl(OUT_PATH, []);
    fs.writeFileSync(REPORT_PATH, '# Repo-local PR Sectors\n\nNo Step 0 pass PRs.\n');
    console.log('No Step 0 pass PRs; wrote empty sector artifacts.');
    return;
  }
  const cards = prs.map(cardFor);
  writeJsonl(OUT_PATH, cards);

  const buckets = new Map<string, number[]>();
  for (const card of cards) for (const sector of card.sectors) {
    const values = buckets.get(sector.sector) ?? [];
    values.push(card.pr);
    buckets.set(sector.sector, values);
  }
  const sizes = [...buckets.entries()].map(([sector, prs]) => ({ sector, size: prs.length }));
  const histogram = {
    '1': sizes.filter((x) => x.size === 1).length,
    '2-5': sizes.filter((x) => x.size >= 2 && x.size <= 5).length,
    '6-20': sizes.filter((x) => x.size >= 6 && x.size <= 20).length,
    '21-50': sizes.filter((x) => x.size >= 21 && x.size <= 50).length,
    '51+': sizes.filter((x) => x.size >= 51).length,
  };
  const covered = cards.filter((card) => card.sectors.length > 0).length;
  const lines = [
    `# Repo-local PR Sectors — ${process.env.REPO ?? 'openclaw/openclaw'}`,
    '',
    `- Pass PRs: **${cards.length}**`,
    `- PRs with at least one sector: **${covered}**`,
    `- Unique sectors: **${buckets.size}**`,
    `- Maximum sectors per PR: **${MAX_SECTORS_PER_PR}**`,
    '',
    '| bucket size | sector count |', '|---:|---:|',
    ...Object.entries(histogram).map(([range, count]) => `| ${range} PRs | ${count} |`),
    '',
    '> Sectors are candidate-generation buckets. Labels are optional evidence; file paths create sectors when labels are absent.',
    '',
    '| sector | PRs |', '|---|---:|',
    ...sizes.sort((a, b) => b.size - a.size || a.sector.localeCompare(b.sector)).map((row) => `| ${row.sector} | ${row.size} |`),
    '',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`Wrote ${OUT_PATH} and ${REPORT_PATH} (${buckets.size} sectors).`);
}

main();
