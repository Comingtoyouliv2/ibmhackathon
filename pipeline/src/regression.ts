/**
 * Golden-set regression: classify frozen PR snapshots in seeds/golden-set.json.
 * Survives merge/close — fixtures are point-in-time, not live GitHub fetches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { classifyPr } from './classify.js';
import type { GoldenSet } from './types.js';

const SEED_PATH = path.resolve('seeds/golden-set.json');

function main() {
  if (!fs.existsSync(SEED_PATH)) {
    console.error(`Golden set not found: ${SEED_PATH}`);
    process.exit(1);
  }

  const golden: GoldenSet = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  let failed = 0;

  for (const c of golden.cases) {
    const result = classifyPr(c.pr);
    const errors: string[] = [];

    if (result.verdict !== c.expect) {
      errors.push(`verdict: got ${result.verdict}, want ${c.expect}`);
    }
    if (c.reasonIncludes && !result.reason.includes(c.reasonIncludes)) {
      errors.push(`reason: "${result.reason}" missing "${c.reasonIncludes}"`);
    }

    if (errors.length > 0) {
      failed++;
      console.error(`FAIL [${c.id}] ${c.note}`);
      for (const e of errors) console.error(`  ${e}`);
    } else {
      console.log(`ok   [${c.id}] ${result.verdict} — ${result.reason}`);
    }
  }

  console.log(`\n${golden.cases.length - failed}/${golden.cases.length} passed`);
  if (failed > 0) process.exit(1);
}

main();
