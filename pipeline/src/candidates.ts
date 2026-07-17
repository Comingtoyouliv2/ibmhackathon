/** Adaptive sector -> domain/sub-domain -> resource candidate generation. */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, writeJsonl } from './io.js';
import type { CandidatePair, HierarchyAssignment, IntentCard, TouchedResource } from './types.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const CARD_PATH = path.join(DATA_DIR, 'intent-cards.jsonl');
const OUT_PATH = path.join(DATA_DIR, 'candidate-pairs.jsonl');
const ALL_OUT_PATH = path.join(DATA_DIR, 'candidate-pairs-all.jsonl');
const REPORT_PATH = path.join(DATA_DIR, 'candidate-report.md');
const SMALL_SECTOR_MAX = Number(process.env.SMALL_SECTOR_MAX ?? 20);
const LARGE_SECTOR_MIN = Number(process.env.LARGE_SECTOR_MIN ?? 51);
const MAX_RESOURCE_BUCKET = Number(process.env.MAX_RESOURCE_BUCKET ?? 40);
const PAIR_BUDGET = Number(process.env.PAIR_BUDGET ?? 100);
const MAX_PAIRS_PER_PR = Number(process.env.MAX_PAIRS_PER_PR ?? 8);
const MAX_SHARED_RESOURCES = Number(process.env.MAX_SHARED_RESOURCES_PER_PAIR ?? 8);

type Reason = CandidatePair['reasons'][number];
type Stage = CandidatePair['selectionStage'];
interface WorkPair {
  a: number;
  b: number;
  score: number;
  reasons: Reason[];
  resources: Map<string, number>;
  sectors: Set<string>;
  domains: Set<string>;
  subDomains: Set<string>;
  relation: CandidatePair['relation'];
  stage: Stage;
}

const STAGE_RANK: Record<Stage, number> = { small_sector: 0, resource: 1, domain_resource: 2, dependency: 3 };
function pairKey(a: number, b: number): string { return a < b ? `${a}:${b}` : `${b}:${a}`; }
function getPair(pairs: Map<string, WorkPair>, a: number, b: number, stage: Stage): WorkPair {
  const key = pairKey(a, b);
  let pair = pairs.get(key);
  if (!pair) {
    pair = { a: Math.min(a, b), b: Math.max(a, b), score: 0, reasons: [], resources: new Map(), sectors: new Set(), domains: new Set(), subDomains: new Set(), relation: 'independent', stage };
    pairs.set(key, pair);
  }
  if (STAGE_RANK[stage] > STAGE_RANK[pair.stage]) pair.stage = stage;
  return pair;
}
function addReason(pair: WorkPair, signal: string, detail: string, weight: number): void {
  if (pair.reasons.some((reason) => reason.signal === signal && reason.detail === detail)) return;
  pair.reasons.push({ signal, detail, weight });
  pair.score += weight;
}
function hierarchy(card: IntentCard, sector: string): HierarchyAssignment | undefined {
  return card.hierarchy.find((entry) => entry.sector === sector);
}
function tokens(text: string): Set<string> {
  const stop = new Set(['with', 'from', 'that', 'this', 'into', 'when', 'then', 'must', 'will', 'does', 'should', 'existing', 'change']);
  return new Set(text.toLowerCase().replace(/[^a-z0-9_/-]+/g, ' ').split(/\s+/).filter((word) => word.length >= 4 && !stop.has(word)));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / Math.max(1, a.size + b.size - intersection);
}
function resourceWeight(resource: TouchedResource, frequency: number, population: number): number {
  const base = { schema: 10, api: 10, state: 9, config: 9, event: 8, symbol: 7, file: 5, module: 2, issue: 1 } satisfies Record<TouchedResource['kind'], number>;
  const idf = Math.max(0.5, Math.log((population + 1) / (frequency + 1)) + 1);
  return base[resource.kind] * resource.confidence * idf;
}
function operationBonus(a: TouchedResource, b: TouchedResource): number {
  if (a.operation === 'remove' || b.operation === 'remove') return 3;
  if (a.operation === 'contract_change' || b.operation === 'contract_change') return 2;
  if (a.operation !== b.operation && a.operation !== 'unknown' && b.operation !== 'unknown') return 1;
  return 0;
}
function addResourcePairs(
  pairs: Map<string, WorkPair>,
  cards: IntentCard[],
  stage: 'resource' | 'domain_resource',
  scope: { sector: string; domain?: string; subDomain?: string },
  stats: { skipped: number },
): void {
  const index = new Map<string, Array<{ card: IntentCard; resource: TouchedResource }>>();
  for (const card of cards) for (const resource of card.touchedResources) {
    const rows = index.get(resource.key) ?? [];
    rows.push({ card, resource });
    index.set(resource.key, rows);
  }
  for (const [key, rows] of index) {
    if (rows.length < 2) continue;
    if (rows.length > MAX_RESOURCE_BUCKET) { stats.skipped++; continue; }
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const pair = getPair(pairs, rows[i].card.pr, rows[j].card.pr, stage);
      pair.sectors.add(scope.sector);
      if (scope.domain) pair.domains.add(`${scope.sector}/${scope.domain}`);
      if (scope.subDomain) pair.subDomains.add(`${scope.sector}/${scope.domain}/${scope.subDomain}`);
      const weight = resourceWeight(rows[i].resource, rows.length, cards.length) + operationBonus(rows[i].resource, rows[j].resource);
      pair.resources.set(key, Math.max(pair.resources.get(key) ?? 0, weight));
      addReason(pair, 'shared_resource', key, weight);
    }
  }
}

function explicitRelations(cards: IntentCard[], pairs: Map<string, WorkPair>): void {
  const known = new Set(cards.map((card) => card.pr));
  for (const card of cards) for (const dependency of card.dependencies) {
    if (dependency.relation === 'related') continue;
    if (!known.has(dependency.pr) || dependency.pr === card.pr) continue;
    const pair = getPair(pairs, card.pr, dependency.pr, 'dependency');
    pair.relation = 'explicit_dependency';
    addReason(pair, `explicit_${dependency.relation}`, `#${card.pr} ${dependency.relation.replace('_', ' ')} #${dependency.pr}`, 30);
  }
}

function resourceHypothesis(key: string, a?: TouchedResource, b?: TouchedResource): string {
  const operations = `PR A=${a?.operation ?? 'unknown'}, PR B=${b?.operation ?? 'unknown'}`;
  const value = key.replace(/^[^:]+:/, '');
  if (key.startsWith('schema:')) return `Both PRs modify schema contract \`${value}\` (${operations}). Verify field types, required fields, defaults, and compatibility with consumers on both sides.`;
  if (key.startsWith('api:')) return `Both PRs modify API/RPC \`${value}\` (${operations}). Verify that request, response, authorization, error contracts, and call ordering agree.`;
  if (key.startsWith('config:')) return `Both PRs modify configuration \`${value}\` (${operations}). Verify consistent defaults, validation, migration, and read/write semantics.`;
  if (key.startsWith('state:')) return `Both PRs modify persistent state \`${value}\` (${operations}). Verify compatible schema, lifecycle, concurrency, and migration assumptions.`;
  if (key.startsWith('event:')) return `Both PRs modify event \`${value}\` (${operations}). Verify compatible payloads and producer/consumer ordering.`;
  if (key.startsWith('symbol:')) return `Both PRs modify public contract \`${value}\` (${operations}). Verify that the signature remains compatible with every caller assumption.`;
  return `Both PRs modify implementation file \`${value}\` (${operations}). Verify actual hunk overlap and post-merge control flow.`;
}
function hypotheses(pair: WorkPair, byPr: Map<number, IntentCard>): string[] {
  const a = byPr.get(pair.a)!;
  const b = byPr.get(pair.b)!;
  const notes: string[] = [];
  if (pair.relation === 'explicit_dependency') notes.push('The PR body declares an explicit stack or dependency relationship. Verify the expected merge order and base relationship before treating this as an independent conflict.');
  for (const key of [...pair.resources.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([key]) => key)) {
    notes.push(resourceHypothesis(key, a.touchedResources.find((resource) => resource.key === key), b.touchedResources.find((resource) => resource.key === key)));
  }
  const assumptionA = a.assumptions[0];
  const assumptionB = b.assumptions[0];
  if (assumptionA && assumptionB && jaccard(tokens(assumptionA), tokens(assumptionB)) >= 0.12) {
    notes.push(`Assumption comparison required — A: “${assumptionA.slice(0, 180)}” / B: “${assumptionB.slice(0, 180)}”`);
  }
  return notes.slice(0, 4);
}
function escapeMd(value: string): string { return value.replace(/\|/g, '\\|').replace(/\n/g, ' '); }

function toOutput(pair: WorkPair, byPr: Map<number, IntentCard>): CandidatePair {
  return {
    prA: pair.a,
    prB: pair.b,
    score: Number(pair.score.toFixed(3)),
    reasons: pair.reasons.sort((a, b) => b.weight - a.weight).slice(0, 12),
    sharedResources: [...pair.resources.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SHARED_RESOURCES).map(([key]) => key),
    sharedSectors: [...pair.sectors].sort(),
    sharedDomains: [...pair.domains].sort(),
    sharedSubDomains: [...pair.subDomains].sort(),
    relation: pair.relation,
    selectionStage: pair.stage,
    potentialConflicts: hypotheses(pair, byPr),
    status: 'needs_review',
  };
}

function main(): void {
  const cards = readJsonl<IntentCard>(CARD_PATH);
  if (!fs.existsSync(CARD_PATH)) throw new Error('data/intent-cards.jsonl missing. Run sectors and intent first.');
  if (!cards.length) {
    writeJsonl(ALL_OUT_PATH, []); writeJsonl(OUT_PATH, []);
    fs.writeFileSync(REPORT_PATH, '# PR×PR Candidate Review Queue\n\nNo Step 0 pass PRs.\n');
    console.log('No intent cards; wrote empty candidate artifacts.');
    return;
  }
  const byPr = new Map(cards.map((card) => [card.pr, card]));
  const sectorIndex = new Map<string, IntentCard[]>();
  for (const card of cards) for (const sector of card.sectors) {
    const rows = sectorIndex.get(sector) ?? [];
    rows.push(card);
    sectorIndex.set(sector, rows);
  }
  const pairs = new Map<string, WorkPair>();
  const stats = { skipped: 0, small: 0, medium: 0, large: 0 };
  for (const [sector, rows] of sectorIndex) {
    if (rows.length <= SMALL_SECTOR_MAX) {
      stats.small++;
      for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
        const pair = getPair(pairs, rows[i].pr, rows[j].pr, 'small_sector');
        pair.sectors.add(sector);
        addReason(pair, 'same_small_sector', `${sector} (${rows.length} PRs)`, 1.5);
      }
      continue;
    }
    if (rows.length < LARGE_SECTOR_MIN) {
      stats.medium++;
      addResourcePairs(pairs, rows, 'resource', { sector }, stats);
      continue;
    }
    stats.large++;
    const domains = new Map<string, IntentCard[]>();
    for (const card of rows) {
      const assignment = hierarchy(card, sector);
      if (!assignment) continue;
      const group = domains.get(assignment.domain) ?? [];
      group.push(card);
      domains.set(assignment.domain, group);
    }
    for (const [domain, domainCards] of domains) {
      if (domainCards.length <= 50) {
        addResourcePairs(pairs, domainCards, 'domain_resource', { sector, domain }, stats);
        continue;
      }
      const subDomains = new Map<string, IntentCard[]>();
      for (const card of domainCards) {
        const subDomain = hierarchy(card, sector)?.subDomain ?? 'unclassified';
        const group = subDomains.get(subDomain) ?? [];
        group.push(card);
        subDomains.set(subDomain, group);
      }
      for (const [subDomain, subDomainCards] of subDomains) addResourcePairs(pairs, subDomainCards, 'domain_resource', { sector, domain, subDomain }, stats);
    }
  }
  explicitRelations(cards, pairs);

  for (const pair of pairs.values()) {
    const a = byPr.get(pair.a)!;
    const b = byPr.get(pair.b)!;
    const similarity = jaccard(tokens(`${a.title} ${a.summary}`), tokens(`${b.title} ${b.summary}`));
    if (similarity >= 0.18) addReason(pair, 'intent_similarity', `${similarity.toFixed(2)} Jaccard`, similarity * 5);
  }

  const ranked = [...pairs.values()].sort((a, b) => b.score - a.score || a.a - b.a || a.b - b.b);
  const selected: WorkPair[] = [];
  const perPr = new Map<number, number>();
  for (const pair of ranked) {
    if (selected.length >= PAIR_BUDGET) break;
    if ((perPr.get(pair.a) ?? 0) >= MAX_PAIRS_PER_PR || (perPr.get(pair.b) ?? 0) >= MAX_PAIRS_PER_PR) continue;
    selected.push(pair);
    perPr.set(pair.a, (perPr.get(pair.a) ?? 0) + 1);
    perPr.set(pair.b, (perPr.get(pair.b) ?? 0) + 1);
  }
  const allOutput = ranked.map((pair) => toOutput(pair, byPr));
  const output = selected.map((pair) => toOutput(pair, byPr));
  writeJsonl(ALL_OUT_PATH, allOutput);
  writeJsonl(OUT_PATH, output);
  const allPairs = cards.length * (cards.length - 1) / 2;
  const lines = [
    `# PR×PR Candidate Review Queue — ${process.env.REPO ?? 'openclaw/openclaw'}`,
    '',
    `- Intent cards: **${cards.length}**`,
    `- Theoretical all-pairs: **${allPairs}**`,
    `- Sectors: **${sectorIndex.size}** (small ${stats.small}, medium ${stats.medium}, large ${stats.large})`,
    `- Candidate pairs before global budget: **${pairs.size}**`,
    `- Resource buckets skipped (>${MAX_RESOURCE_BUCKET} PRs): **${stats.skipped}**`,
    `- Review queue: **${output.length}** / budget ${PAIR_BUDGET}`,
    '',
    '> Potential conflicts are grounded review hypotheses, not verdicts. Explicit stacked/dependency relations are marked separately.',
    '',
    '| score | PR A | PR B | stage | hierarchy | shared resources | potential conflict to verify |',
    '|---:|---|---|---|---|---|---|',
    ...output.map((pair) => {
      const a = byPr.get(pair.prA)!;
      const b = byPr.get(pair.prB)!;
      const hierarchyText = [...pair.sharedSectors, ...pair.sharedDomains, ...pair.sharedSubDomains].join('<br>');
      return `| ${pair.score} | [#${pair.prA}](https://github.com/${process.env.REPO ?? 'openclaw/openclaw'}/pull/${pair.prA}) ${escapeMd(a.title)} | [#${pair.prB}](https://github.com/${process.env.REPO ?? 'openclaw/openclaw'}/pull/${pair.prB}) ${escapeMd(b.title)} | ${pair.selectionStage}${pair.relation === 'explicit_dependency' ? '<br>dependency' : ''} | ${hierarchyText} | ${pair.sharedResources.join('<br>')} | ${pair.potentialConflicts.map(escapeMd).join('<br>')} |`;
    }),
    '',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`Wrote ${ALL_OUT_PATH}, ${OUT_PATH}, and ${REPORT_PATH}: ${pairs.size} bounded candidates -> ${output.length} review pairs.`);
}

main();
