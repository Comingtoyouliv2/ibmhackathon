/**
 * Step 3 preparation: turn each bounded candidate pair into a portable review
 * packet. IBM Bob can consume these packets later, while they are also readable
 * by a human without revisiting the whole open-PR population.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, writeJsonl } from './io.js';
import type { CandidatePair, IntentCard, PrDiff, ReviewPacket } from './types.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const CARD_PATH = path.join(DATA_DIR, 'intent-cards.jsonl');
const DIFF_PATH = path.join(DATA_DIR, 'pr-diffs.jsonl');
const CANDIDATE_PATH = path.join(DATA_DIR, 'candidate-pairs.jsonl');
const OUT_PATH = path.join(DATA_DIR, 'review-packets.jsonl');
const REPORT_PATH = path.join(DATA_DIR, 'review-packets.md');
const REPO = process.env.REPO ?? 'openclaw/openclaw';
const MAX_EXCERPTS_PER_PR = Number(process.env.MAX_EXCERPTS_PER_PR ?? 3);
const MAX_EXCERPT_CHARS = Number(process.env.MAX_EXCERPT_CHARS ?? 4_000);

type DiffFile = PrDiff['files'][number];

function resourcePath(resource: string): string | undefined {
  if (resource.startsWith('file:')) return resource.slice('file:'.length);
  if (resource.startsWith('symbol:')) return resource.slice('symbol:'.length).split('#')[0];
  if (resource.startsWith('schema:')) return resource.slice('schema:'.length).split('#')[0];
  return undefined;
}

function isRelevant(file: DiffFile, sharedResources: string[], evidencePaths: string[]): boolean {
  const normalized = file.path.replace(/\.[^.]+$/, '').replace(/\/index$/, '');
  if (sharedResources.some((resource) => {
    const resourceStem = resourcePath(resource);
    return resourceStem && (normalized === resourceStem || normalized.startsWith(`${resourceStem}/`) || resourceStem.startsWith(`${normalized}/`));
  })) return true;
  return evidencePaths.some((value) => value === file.path || value.startsWith(`${file.path}:`));
}

function excerpt(patch?: string): string | undefined {
  if (!patch) return undefined;
  return patch.length <= MAX_EXCERPT_CHARS
    ? patch
    : `${patch.slice(0, MAX_EXCERPT_CHARS)}\n… [excerpt truncated]`;
}

function evidenceFor(
  pr: number,
  diff: PrDiff | undefined,
  sharedResources: string[],
  card: IntentCard,
): ReviewPacket['evidence']['diffExcerpts'] {
  if (!diff) return [];
  const shared = new Set(sharedResources);
  const evidencePaths = card.touchedResources
    .filter((resource) => shared.has(resource.key))
    .flatMap((resource) => resource.evidence);
  const relevant = diff.files.filter((file) => isRelevant(file, sharedResources, evidencePaths));
  // If no file exactly represents an extracted resource (for example an event
  // name), retain a small deterministic sample rather than silently omitting
  // all diff evidence.
  const selected = (relevant.length ? relevant : diff.files).slice(0, MAX_EXCERPTS_PER_PR);
  return selected.map((file) => ({
    pr,
    path: file.path,
    status: file.status,
    patchExcerpt: excerpt(file.patch),
    patchTruncated: file.patchTruncated || Boolean(file.patch && file.patch.length > MAX_EXCERPT_CHARS),
  }));
}

function markdownEscape(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function main(): void {
  const cards = new Map(readJsonl<IntentCard>(CARD_PATH).map((card) => [card.pr, card]));
  const candidates = readJsonl<CandidatePair>(CANDIDATE_PATH);
  if (!fs.existsSync(CARD_PATH) || !fs.existsSync(CANDIDATE_PATH)) {
    console.error('Intent cards or candidates are missing. Run `npm run intent` then `npm run candidates` first.');
    process.exit(1);
  }
  const diffs = new Map(readJsonl<PrDiff>(DIFF_PATH).map((diff) => [diff.pr, diff]));
  const packets: ReviewPacket[] = [];

  for (const candidate of candidates) {
    const prA = cards.get(candidate.prA);
    const prB = cards.get(candidate.prB);
    if (!prA || !prB) continue;
    packets.push({
      id: `${REPO}#${candidate.prA}-${candidate.prB}`,
      repo: REPO,
      candidate,
      prA,
      prB,
      evidence: {
        sharedResources: candidate.sharedResources,
        sharedSectors: candidate.sharedSectors,
        sharedDomains: candidate.sharedDomains,
        sharedSubDomains: candidate.sharedSubDomains,
        diffExcerpts: [
          ...evidenceFor(candidate.prA, diffs.get(candidate.prA), candidate.sharedResources, prA),
          ...evidenceFor(candidate.prB, diffs.get(candidate.prB), candidate.sharedResources, prB),
        ],
      },
      reviewInstructions: {
        objective: 'Determine whether these two open PRs can create an integration conflict with each other. Do not evaluate PR-to-main mergeability.',
        questions: [
          'Do both PRs write, remove, or change the contract of the same resource?',
          'Could their assumptions or resulting behavior be incompatible when both changes land?',
          'Is the available evidence sufficient? Return uncertain rather than inventing a conflict.',
        ],
        verdicts: ['conflict', 'no_conflict', 'uncertain'],
      },
      status: 'unreviewed',
    });
  }
  writeJsonl(OUT_PATH, packets);

  const lines = [
    `# PR×PR Review Packets — ${REPO}`,
    '',
    `- Packets: **${packets.length}**`,
    `- Packets with diff excerpts: **${packets.filter((packet) => packet.evidence.diffExcerpts.length > 0).length}**`,
    '',
    '> Every entry is unreviewed. It is a bounded handoff for IBM Bob or a human reviewer, not a conflict verdict.',
    '',
    '| packet | PR A | PR B | hierarchy | shared concrete resources | hypothesis | status |',
    '|---|---|---|---|---|---|---|',
    ...packets.map((packet) => `| ${packet.id} | [#${packet.prA.pr}](https://github.com/${REPO}/pull/${packet.prA.pr}) ${markdownEscape(packet.prA.title)} | [#${packet.prB.pr}](https://github.com/${REPO}/pull/${packet.prB.pr}) ${markdownEscape(packet.prB.title)} | ${[...packet.evidence.sharedSectors, ...packet.evidence.sharedDomains, ...packet.evidence.sharedSubDomains].join('<br>')} | ${packet.evidence.sharedResources.join('<br>')} | ${packet.candidate.potentialConflicts.map(markdownEscape).join('<br>')} | ${packet.status} |`),
    '',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`Wrote ${OUT_PATH} and ${REPORT_PATH} (${packets.length} unreviewed packets).`);
}

main();
