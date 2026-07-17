/** Fail fast when generated artifacts violate the pipeline contract. */
import 'dotenv/config';
import path from 'node:path';
import { readJsonl } from './io.js';
import type { CandidatePair, IntentCard, RawPr, ReviewPacket } from './types.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const MAX_RESOURCES = Number(process.env.MAX_RESOURCES_PER_PR ?? 12);

function pairKey(a: number, b: number): string { return a < b ? `${a}:${b}` : `${b}:${a}`; }
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main(): void {
  const passed = readJsonl<RawPr>(path.join(DATA_DIR, 'passed.jsonl'));
  const cards = readJsonl<IntentCard>(path.join(DATA_DIR, 'intent-cards.jsonl'));
  const allCandidates = readJsonl<CandidatePair>(path.join(DATA_DIR, 'candidate-pairs-all.jsonl'));
  const queue = readJsonl<CandidatePair>(path.join(DATA_DIR, 'candidate-pairs.jsonl'));
  const packets = readJsonl<ReviewPacket>(path.join(DATA_DIR, 'review-packets.jsonl'));
  if (!passed.length) {
    assert(cards.length === 0 && allCandidates.length === 0 && queue.length === 0 && packets.length === 0, 'zero-pass run produced non-empty downstream artifacts');
    console.log('audit ok: 0 pass PRs and empty downstream artifacts');
    return;
  }
  assert(cards.length === passed.length, `intent card count ${cards.length} != pass count ${passed.length}`);
  const passedPrs = new Set(passed.map((pr) => pr.number));
  for (const card of cards) {
    assert(passedPrs.has(card.pr), `card #${card.pr} did not pass Step 0`);
    assert(card.touchedResources.length <= MAX_RESOURCES, `card #${card.pr} exceeds ${MAX_RESOURCES} resources`);
    assert(new Set(card.touchedResources.map((resource) => resource.key)).size === card.touchedResources.length, `card #${card.pr} has duplicate resources`);
    assert(card.hierarchy.every((entry) => card.sectors.includes(entry.sector)), `card #${card.pr} hierarchy references an unassigned sector`);
    for (const resource of card.touchedResources) {
      assert(!/^schema:.*(?:\.test|\.spec)|^api:.*\.(?:jsonl?|[cm]?[jt]sx?|md|ya?ml)$/i.test(resource.key), `card #${card.pr} has noisy resource ${resource.key}`);
    }
  }
  const allKeys = new Set<string>();
  for (const pair of allCandidates) {
    assert(pair.prA < pair.prB, `candidate order is not canonical: ${pair.prA}, ${pair.prB}`);
    assert(passedPrs.has(pair.prA) && passedPrs.has(pair.prB), `candidate contains non-pass PR: ${pair.prA}, ${pair.prB}`);
    const key = pairKey(pair.prA, pair.prB);
    assert(!allKeys.has(key), `duplicate candidate pair ${key}`);
    allKeys.add(key);
  }
  const queueKeys = new Set<string>();
  for (const pair of queue) {
    const key = pairKey(pair.prA, pair.prB);
    assert(allKeys.has(key), `queue pair ${key} is absent from retrieval candidates`);
    assert(!queueKeys.has(key), `duplicate queue pair ${key}`);
    queueKeys.add(key);
  }
  assert(packets.length === queue.length, `packet count ${packets.length} != queue count ${queue.length}`);
  for (const packet of packets) assert(queueKeys.has(pairKey(packet.prA.pr, packet.prB.pr)), `packet ${packet.id} has no queue pair`);
  console.log(`audit ok: ${passed.length} pass PRs, ${allCandidates.length} retrieval candidates, ${queue.length} queued pairs, ${packets.length} packets`);
}

main();
