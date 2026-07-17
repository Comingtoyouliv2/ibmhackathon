/** Evaluate the retrieval rule and the bounded queue independently. */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl } from './io.js';
import type { CandidatePair, IntentCard, PairLabel } from './types.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const LABEL_PATH = path.resolve(process.env.PAIR_LABELS_PATH ?? path.join(DATA_DIR, 'pair-labels.jsonl'));
const ALL_PATH = path.resolve(process.env.ALL_CANDIDATES_PATH ?? path.join(DATA_DIR, 'candidate-pairs-all.jsonl'));
const QUEUE_PATH = path.resolve(process.env.CANDIDATES_PATH ?? path.join(DATA_DIR, 'candidate-pairs.jsonl'));
const CARD_PATH = path.resolve(process.env.INTENT_CARDS_PATH ?? path.join(DATA_DIR, 'intent-cards.jsonl'));
const REPORT_PATH = path.resolve(process.env.EVALUATION_REPORT_PATH ?? path.join(DATA_DIR, 'evaluation-report.md'));

function key(a: number, b: number): string { return a < b ? `${a}:${b}` : `${b}:${a}`; }
function percent(value: number, total: number): string { return total ? `${(100 * value / total).toFixed(1)}%` : 'n/a'; }

function main(): void {
  const labels = readJsonl<PairLabel>(LABEL_PATH);
  if (!labels.length) throw new Error(`No pair labels at ${LABEL_PATH}. Create labels using seeds/pair-labels.example.jsonl as the schema.`);
  const allCandidates = readJsonl<CandidatePair>(ALL_PATH);
  const queue = readJsonl<CandidatePair>(QUEUE_PATH);
  const cards = readJsonl<IntentCard>(CARD_PATH);
  const allSet = new Set(allCandidates.map((pair) => key(pair.prA, pair.prB)));
  const queueSet = new Set(queue.map((pair) => key(pair.prA, pair.prB)));
  const positives = labels.filter((label) => label.expected === 'review');
  const negatives = labels.filter((label) => label.expected === 'ignore');
  const retrievedPositive = positives.filter((label) => allSet.has(key(label.prA, label.prB)));
  const queuedPositive = positives.filter((label) => queueSet.has(key(label.prA, label.prB)));
  const retrievedLabelled = labels.filter((label) => allSet.has(key(label.prA, label.prB)));
  const queuedLabelled = labels.filter((label) => queueSet.has(key(label.prA, label.prB)));
  const retrievedTrue = retrievedLabelled.filter((label) => label.expected === 'review');
  const queuedTrue = queuedLabelled.filter((label) => label.expected === 'review');
  const falseNegatives = positives.filter((label) => !allSet.has(key(label.prA, label.prB)));
  const universePrs = cards.length || new Set(labels.flatMap((label) => [label.prA, label.prB])).size;
  const universePairs = universePrs * (universePrs - 1) / 2;
  const lines = [
    '# Closed-PR Pair Retrieval Evaluation',
    '',
    `- Labelled pairs: **${labels.length}** (review ${positives.length}, ignore ${negatives.length})`,
    `- Eligible PR universe: **${universePrs}** / theoretical pairs **${universePairs}**`,
    `- Retrieval candidates: **${allCandidates.length}** (${percent(allCandidates.length, universePairs)} of all pairs)`,
    `- Review queue: **${queue.length}** (${percent(queue.length, universePairs)} of all pairs)`,
    '',
    '## Metrics',
    '',
    `- Retrieval recall: **${retrievedPositive.length}/${positives.length} (${percent(retrievedPositive.length, positives.length)})**`,
    `- Queue recall: **${queuedPositive.length}/${positives.length} (${percent(queuedPositive.length, positives.length)})**`,
    `- Labelled retrieval precision: **${retrievedTrue.length}/${retrievedLabelled.length} (${percent(retrievedTrue.length, retrievedLabelled.length)})**`,
    `- Labelled queue precision: **${queuedTrue.length}/${queuedLabelled.length} (${percent(queuedTrue.length, queuedLabelled.length)})**`,
    '',
    '> Recall measures the hierarchy/resource rule. Queue recall additionally measures scoring and budget. Precision is meaningful only when negative labels were sampled deliberately.',
    '',
    '## Retrieval false negatives',
    '',
    '| PR A | PR B | expected verdict | note |',
    '|---:|---:|---|---|',
    ...(falseNegatives.length ? falseNegatives.map((label) => `| ${label.prA} | ${label.prB} | ${label.verdict ?? 'unspecified'} | ${(label.note ?? '').replace(/\|/g, '\\|')} |`) : ['| — | — | — | none |']),
    '',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`Wrote ${REPORT_PATH}: retrieval recall ${retrievedPositive.length}/${positives.length}, queue recall ${queuedPositive.length}/${positives.length}.`);
}

main();
