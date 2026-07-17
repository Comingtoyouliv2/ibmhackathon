/**
 * Build bounded Intent Cards from Step 0 pass PRs. This extractor is grounded
 * in authored intent, changed contracts, and repo-local hierarchy. It is still
 * deterministic; IBM Bob can later replace it without changing the contract.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { classifyHierarchy } from './hierarchy.js';
import { readJsonl, writeJsonl } from './io.js';
import type { IntentCard, PrDiff, RawPr, SectorCard, TouchedResource } from './types.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const PASSED_PATH = path.join(DATA_DIR, 'passed.jsonl');
const DIFF_PATH = path.join(DATA_DIR, 'pr-diffs.jsonl');
const SECTOR_PATH = path.join(DATA_DIR, 'sectors.jsonl');
const OUT_PATH = path.join(DATA_DIR, 'intent-cards.jsonl');
const MAX_RESOURCES_PER_PR = Number(process.env.MAX_RESOURCES_PER_PR ?? 12);
const MAX_FILE_RESOURCES = Number(process.env.MAX_FILE_RESOURCES ?? 6);

type Operation = TouchedResource['operation'];
interface RankedResource { resource: TouchedResource; priority: number }

function uniq<T>(values: T[]): T[] { return [...new Set(values)]; }
function stem(filePath: string): string {
  return filePath.replace(/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|cpp|c|h|json|ya?ml|sql)$/i, '').replace(/\/index$/i, '');
}
function changedLines(patch?: string): string[] {
  return (patch ?? '').split('\n').filter((line) => /^[+-](?![+-])/.test(line));
}
function operation(patch: string | undefined, status: string | undefined): Operation {
  if (status === 'removed') return 'remove';
  const lines = changedLines(patch);
  const added = lines.some((line) => line.startsWith('+'));
  const removed = lines.some((line) => line.startsWith('-'));
  if (added && removed) return 'contract_change';
  if (added) return 'write';
  if (removed) return 'remove';
  return 'unknown';
}
function add(out: Map<string, RankedResource>, resource: TouchedResource, priority: number): void {
  const current = out.get(resource.key);
  if (!current) { out.set(resource.key, { resource, priority }); return; }
  current.resource.evidence = uniq([...current.resource.evidence, ...resource.evidence]).slice(0, 4);
  current.resource.confidence = Math.max(current.resource.confidence, resource.confidence);
  current.priority = Math.max(current.priority, priority);
  if (current.resource.operation === 'unknown') current.resource.operation = resource.operation;
}
function matches(re: RegExp, text: string, group = 1): string[] {
  re.lastIndex = 0;
  return [...text.matchAll(re)].map((match) => match[group] ?? match[0]);
}
function isNoisePath(filePath: string): boolean {
  return /(^|\/)(?:docs?|test|tests|fixtures|snapshots?|__tests__)(\/|$)|\.(?:test|spec|fixture)\.[^/]+$|(?:^|[._-])generated(?:[._-]|$)|\.(?:md|snap)$/i.test(filePath);
}
function isContractFile(filePath: string): boolean {
  const basename = filePath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
  return /(?:^|[._-])(?:schema|protocol|types?|config)(?:[._-]|$)/i.test(basename);
}
function filePriority(filePath: string): number {
  let score = isNoisePath(filePath) ? -10 : 2;
  if (/(?:schema|protocol|api|rpc|config|migration|state|store|database|approval)/i.test(filePath)) score += 5;
  if (/\.(?:sql|json|ya?ml)$/i.test(filePath)) score += 2;
  return score;
}
function areaFor(filePath: string): string {
  const parts = stem(filePath).split('/');
  return parts.slice(0, Math.min(parts.length, 3)).join('/');
}

function collectResources(pr: RawPr, diff?: PrDiff): TouchedResource[] {
  const out = new Map<string, RankedResource>();
  const diffs = new Map((diff?.files ?? []).map((file) => [file.path, file]));
  const rankedFiles = pr.files
    .filter((file) => !isNoisePath(file.path))
    .sort((a, b) => filePriority(b.path) - filePriority(a.path) || (b.additions + b.deletions) - (a.additions + a.deletions))
    .slice(0, MAX_FILE_RESOURCES);
  for (const file of rankedFiles) {
    const patch = diffs.get(file.path);
    add(out, {
      key: `file:${stem(file.path)}`,
      kind: 'file',
      operation: operation(patch?.patch, patch?.status),
      evidence: [file.path],
      confidence: patch?.patch ? 0.92 : 0.62,
    }, 25 + filePriority(file.path));
  }

  for (const file of diff?.files ?? []) {
    const lines = changedLines(file.patch);
    if (!lines.length || isNoisePath(file.path)) continue;
    const text = lines.join('\n');
    const op = operation(file.patch, file.status);
    const evidenceLine = (needle: string) => `${file.path}: ${lines.find((line) => line.includes(needle))?.slice(0, 180) ?? needle}`;

    const envNames = uniq([
      ...matches(/\b(?:process|Bun)\.env\.([A-Z][A-Z0-9_]*)\b/g, text),
      ...matches(/\bDeno\.env\.get\(["'`]([A-Z][A-Z0-9_]*)["'`]\)/g, text),
    ]);
    for (const name of envNames) add(out, {
      key: `config:env:${name}`, kind: 'config', operation: op,
      evidence: [evidenceLine(name)], confidence: 0.97,
    }, 100);

    if (isContractFile(file.path)) {
      for (const key of uniq(matches(/^[+-]\s*(?:readonly\s+)?["']?([A-Za-z][\w-]*)["']?\??\s*:/gm, text)).slice(0, 8)) {
        add(out, {
          key: `schema:${areaFor(file.path)}#${key}`, kind: 'schema', operation: op,
          evidence: [evidenceLine(key)], confidence: 0.88,
        }, 90);
      }
    }

    if (/(?:gateway|protocol|api|rpc|server-method)/i.test(file.path)) {
      const methods = uniq(matches(/["'`]([a-z][a-z0-9_-]+(?:\.[a-z][a-z0-9_-]+)+)["'`]/g, text))
        .filter((method) => !/\.(?:jsonl?|[cm]?[jt]sx?|md|ya?ml|sql|log|txt)$/i.test(method))
        .slice(0, 8);
      for (const method of methods) {
        add(out, {
          key: `api:${method}`, kind: 'api', operation: op,
          evidence: [evidenceLine(method)], confidence: 0.9,
        }, 95);
      }
    }

    for (const event of uniq(matches(/["'`]([a-z][a-z0-9_.:-]*(?:created|updated|deleted|failed|started|completed|requested|changed))["'`]/gi, text)).slice(0, 5)) {
      add(out, {
        key: `event:${event.toLowerCase()}`, kind: 'event', operation: op,
        evidence: [evidenceLine(event)], confidence: 0.88,
      }, 85);
    }

    if (/\.sql$/i.test(file.path)) {
      for (const table of uniq(matches(/\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["'`]?([\w.-]+)/gi, text))) {
        add(out, {
          key: `state:table:${table.toLowerCase()}`, kind: 'state', operation: op,
          evidence: [evidenceLine(table)], confidence: 0.98,
        }, 100);
      }
    }

    for (const symbol of uniq(matches(/^[+-]\s*export\s+(?:declare\s+)?(?:async\s+)?(?:interface|type|class|function|const|enum)\s+([A-Za-z_$][\w$]*)/gm, text)).slice(0, 6)) {
      add(out, {
        key: `symbol:${stem(file.path)}#${symbol}`, kind: 'symbol', operation: op,
        evidence: [evidenceLine(symbol)], confidence: 0.93,
      }, 80);
    }
  }

  return [...out.values()]
    .sort((a, b) => b.priority - a.priority || b.resource.confidence - a.resource.confidence || a.resource.key.localeCompare(b.resource.key))
    .slice(0, MAX_RESOURCES_PER_PR)
    .map((entry) => entry.resource);
}

function bodySections(body: string): Map<string, string> {
  const known = /^(summary|what problem this solves|problem|root cause|why this change was made|user impact|what changed|changes|fix|out of scope|risk mitigations?)\s*:??\s*$/i;
  const sections = new Map<string, string[]>();
  let current = 'intro';
  sections.set(current, []);
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (known.test(line)) { current = line.toLowerCase().replace(/:$/, ''); sections.set(current, []); continue; }
    sections.get(current)?.push(rawLine);
  }
  return new Map([...sections].map(([key, lines]) => [key, lines.join('\n').trim()]));
}
function firstText(sections: Map<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = sections.get(key)?.replace(/\s+/g, ' ').trim();
    if (value) return value.slice(0, 600);
  }
  return undefined;
}
function assumptions(body: string): string[] {
  return uniq(body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim().replace(/^[-*]\s*/, ''))
    .filter((sentence) => /\b(?:assum(?:e|es|ed|ption)|must|always|never|intentionally|out of scope|remain|does not|do not)\b/i.test(sentence))
    .filter((sentence) => sentence.length >= 18 && sentence.length <= 360))
    .slice(0, 5);
}
function dependencies(body: string): IntentCard['dependencies'] {
  const out: IntentCard['dependencies'] = [];
  const patterns: Array<[RegExp, IntentCard['dependencies'][number]['relation']]> = [
    [/\bstacked\s+(?:on|over)\s+#(\d+)/gi, 'stacked_on'],
    [/\bdepends?\s+on\s+#(\d+)/gi, 'depends_on'],
    [/\brelated\s*:??\s*#(\d+)/gi, 'related'],
  ];
  for (const [re, relation] of patterns) for (const value of matches(re, body)) out.push({ pr: Number(value), relation });
  return out.filter((row, index) => Number.isFinite(row.pr) && out.findIndex((other) => other.pr === row.pr && other.relation === row.relation) === index);
}

function main(): void {
  const prs = readJsonl<RawPr>(PASSED_PATH);
  const sectors = new Map(readJsonl<SectorCard>(SECTOR_PATH).map((card) => [card.pr, card]));
  if (!fs.existsSync(PASSED_PATH)) {
    console.error('Missing passed PRs. Run `npm run step0`.');
    process.exit(1);
  }
  if (!prs.length) {
    writeJsonl(OUT_PATH, []);
    console.log('No Step 0 pass PRs; wrote empty intent cards.');
    return;
  }
  if (!sectors.size) {
    console.error('Missing passed PRs or sectors. Run `npm run step0` then `npm run sectors`.');
    process.exit(1);
  }
  const diffs = new Map(readJsonl<PrDiff>(DIFF_PATH).map((diff) => [diff.pr, diff]));
  const cards: IntentCard[] = prs.map((pr) => {
    const diff = diffs.get(pr.number);
    const sectorCard = sectors.get(pr.number) ?? { pr: pr.number, title: pr.title, sectors: [] };
    const hierarchy = classifyHierarchy(pr, diff, sectorCard);
    const resources = collectResources(pr, diff);
    const sections = bodySections(pr.body);
    const problem = firstText(sections, ['what problem this solves', 'problem', 'root cause', 'intro']);
    const changed = firstText(sections, ['user impact', 'what changed', 'changes', 'fix', 'summary']);
    const summary = firstText(sections, ['summary', 'what problem this solves', 'problem', 'intro']) ?? pr.title;
    return {
      pr: pr.number,
      title: pr.title,
      summary,
      domains: uniq(hierarchy.map((entry) => `${entry.sector}/${entry.domain}`)),
      sectors: sectorCard.sectors.map((entry) => entry.sector),
      hierarchy,
      touchedResources: resources,
      assumptions: assumptions(pr.body),
      behaviorChanges: problem && changed ? [{ surface: hierarchy[0]?.domain ?? 'unknown', before: problem, after: changed }] : [],
      dependencies: dependencies(pr.body),
      evidenceQuality: diff?.files.some((file) => file.patch) ? 'diff' : 'metadata_only',
      confidence: diff?.files.some((file) => file.patch) ? 0.72 : 0.42,
      extractor: 'heuristic-v2',
    };
  });
  writeJsonl(OUT_PATH, cards);
  const counts = cards.reduce((acc, card) => {
    acc.resources += card.touchedResources.length;
    acc.assumptions += card.assumptions.length;
    acc.dependencies += card.dependencies.length;
    return acc;
  }, { resources: 0, assumptions: 0, dependencies: 0 });
  console.log(`Wrote ${OUT_PATH}: ${cards.length} cards, ${counts.resources} bounded resources, ${counts.assumptions} assumptions, ${counts.dependencies} explicit relations.`);
}

main();
