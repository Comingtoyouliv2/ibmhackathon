/**
 * Step 0 / sub-step 2: classify fetched PRs and produce the survey report.
 *
 * Reads  data/prs.jsonl
 * Writes data/step0.jsonl   (every PR + verdict/reason — audit trail)
 *        data/passed.jsonl  (raw PRs with verdict=pass — input for Step 1)
 *        data/report.md     (survey: what kinds of PRs exist in this repo)
 */
import fs from 'node:fs';
import path from 'node:path';
import { classifyPr } from './classify.js';
import type { FileClass, RawPr, Step0Result } from './types.js';

const DATA_DIR = path.resolve('data');
const RAW_PATH = path.join(DATA_DIR, 'prs.jsonl');

function loadPrs(): RawPr[] {
  if (!fs.existsSync(RAW_PATH)) {
    console.error('data/prs.jsonl not found. Run `npm run fetch` first.');
    process.exit(1);
  }
  const byNumber = new Map<number, RawPr>(); // dedupe (resume can re-fetch a page)
  for (const line of fs.readFileSync(RAW_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const pr: RawPr = JSON.parse(line);
    byNumber.set(pr.number, pr);
  }
  if (byNumber.size === 0) {
    console.error('data/prs.jsonl is empty. Run `npm run fetch` first.');
    process.exit(1);
  }
  return [...byNumber.values()];
}

function count<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function top(m: Map<string, number>, n: number): Array<[string, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '0%' : `${((part / whole) * 100).toFixed(1)}%`;
}

function dominantClass(r: Step0Result): FileClass | 'none' {
  const entries = Object.entries(r.fileClasses) as Array<[FileClass, number]>;
  if (entries.length === 0) return 'none';
  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

function main() {
  const prs = loadPrs();
  const results = prs.map(classifyPr);
  const byVerdict = {
    pass: results.filter((r) => r.verdict === 'pass'),
    excluded: results.filter((r) => r.verdict === 'excluded'),
    deferred: results.filter((r) => r.verdict === 'deferred'),
  };

  // ---- write outputs ----
  fs.writeFileSync(
    path.join(DATA_DIR, 'step0.jsonl'),
    results.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  // CSV export (Excel-friendly, UTF-8 BOM)
  const REPO = process.env.REPO ?? 'openclaw/openclaw';
  const CLASSES: FileClass[] = ['logic', 'test', 'docs', 'deps', 'config', 'assets'];
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const order: Record<string, number> = { pass: 0, deferred: 1, excluded: 2 };
  const csvRows = [...results].sort((a, b) => order[a.verdict] - order[b.verdict] || b.pr - a.pr);
  const csv = [
    ['pr', 'verdict', 'reason', 'reason_detail', 'signal_strength', 'logic_files', 'logic_lines', 'total_lines',
      'title', 'author', 'bot', 'draft',
      ...CLASSES.map((c) => `files_${c}`), 'files_total', 'updated_at', 'url'].join(','),
    ...csvRows.map((r) =>
      [
        r.pr, r.verdict, r.reason, esc(r.reasonDetail), r.signalStrength,
        r.logicFileCount, r.logicChangeLines, r.totalChangeLines,
        esc(r.title), esc(r.authorLogin),
        r.authorIsBot ? 'Y' : '', r.isDraft ? 'Y' : '',
        ...CLASSES.map((c) => r.fileClasses[c] ?? 0),
        Object.values(r.fileClasses).reduce((a, b) => a + b, 0),
        r.updatedAt, `https://github.com/${REPO}/pull/${r.pr}`,
      ].join(','),
    ),
  ].join('\n');
  fs.writeFileSync(path.join(DATA_DIR, 'step0.csv'), '﻿' + csv + '\n');

  const passedNumbers = new Set(byVerdict.pass.map((r) => r.pr));
  fs.writeFileSync(
    path.join(DATA_DIR, 'passed.jsonl'),
    prs.filter((p) => passedNumbers.has(p.number)).map((p) => JSON.stringify(p)).join('\n') + '\n',
  );

  // ---- survey stats ----
  const total = prs.length;
  const bots = prs.filter((p) => p.authorIsBot).length;
  const drafts = prs.filter((p) => p.isDraft).length;
  const prefix = count(prs, (p) => {
    const m = p.title.match(/^([a-z]+)(\([^)]*\))?!?:/i);
    return m ? m[1].toLowerCase() : '(none)';
  });
  const labels = count(
    prs.flatMap((p) => p.labels),
    (l) => l,
  );
  const reasons = count(results, (r) => `${r.verdict}:${r.reason}`);
  const dominant = count(results, (r) => dominantClass(r));
  const mergeable = count(prs, (p) => p.mergeable);
  const truncated = prs.filter((p) => p.filesTruncated).length;
  const signalStrength = count(results, (r) => r.signalStrength);
  const passHigh = byVerdict.pass.filter((r) => r.signalStrength === 'high').length;
  const passLow = byVerdict.pass.filter((r) => r.signalStrength === 'low').length;
  const passUnknown = byVerdict.pass.filter((r) => r.signalStrength === 'unknown').length;

  const lines: string[] = [];
  const section = (title: string, rows: Array<[string, number]>, denom = total) => {
    lines.push(`\n## ${title}\n`);
    lines.push('| key | count | share |');
    lines.push('|---|---:|---:|');
    for (const [k, v] of rows) lines.push(`| ${k} | ${v} | ${pct(v, denom)} |`);
  };

  lines.push(`# Step 0 Report — ${process.env.REPO ?? 'openclaw/openclaw'}`);
  lines.push(`\nGenerated: ${new Date().toISOString()} · Open PRs analyzed: **${total}**\n`);
  lines.push(`- **pass: ${byVerdict.pass.length}** (${pct(byVerdict.pass.length, total)}) → input for Step 1`);
  lines.push(`  - high signal: ${passHigh} · low signal: ${passLow} · unknown: ${passUnknown}`);
  lines.push(`- excluded: ${byVerdict.excluded.length} (${pct(byVerdict.excluded.length, total)})`);
  lines.push(`- deferred: ${byVerdict.deferred.length} (${pct(byVerdict.deferred.length, total)}) — git conflict with main, revisit after rebase`);
  lines.push(`- bot authors: ${bots} (${pct(bots, total)}) · drafts: ${drafts} · file list truncated (>100 files): ${truncated}`);

  section('Verdict reasons', top(reasons, 20));
  section('Signal strength (all PRs)', top(signalStrength, 5));
  section('Title prefix (conventional commits)', top(prefix, 15));
  section('Dominant file class per PR', top(dominant, 10));
  section('Mergeable state', top(mergeable, 5));
  if (labels.size > 0) section('Top labels', top(labels, 20));

  lines.push('\n## Sample of excluded PRs (manual audit — check for false negatives)\n');
  for (const r of byVerdict.excluded.slice(0, 20)) {
    lines.push(`- #${r.pr} [${r.reason}] ${r.title}`);
  }

  const report = lines.join('\n') + '\n';
  fs.writeFileSync(path.join(DATA_DIR, 'report.md'), report);
  console.log(report);
  console.log(`\nWrote data/step0.jsonl, data/step0.csv, data/passed.jsonl, data/report.md`);
}

main();
