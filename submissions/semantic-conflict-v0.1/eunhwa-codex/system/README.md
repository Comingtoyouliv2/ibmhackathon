# Contract Radar — evaluation system code

This directory contains the runnable Contract Radar implementation submitted for
semantic-conflict system comparison. Generated scan artifacts, benchmark inputs,
model credentials, deployment project IDs, and prediction outputs are intentionally
excluded.

`run-codex-evaluation.mjs` is the exact fixed-prompt evaluation runner used to
produce the six files in the parent directory. To reproduce the submission, copy
that runner to the clean evaluation-suite root and run:

```bash
node run-codex-evaluation.mjs pair 1 10
node run-codex-evaluation.mjs pair 11 20
node run-codex-evaluation.mjs pair 21 30
node run-codex-evaluation.mjs pair 31 40
node run-codex-evaluation.mjs e2e 1
node run-codex-evaluation.mjs e2e 2
node run-codex-evaluation.mjs assemble
```

Oversized input records are mounted unchanged as a read-only `case.json`; their
contents are never truncated. The evaluator uses the suite's fixed prompts and
does not use web search, repository checkout, gold labels, or prior predictions.

## Run and verify

```bash
cd web
npm ci
npm test
npm run lint
npm run build
npm run dev
```

## MergeDataset adapter

Pass the evaluator-owned JSONL path explicitly. The dataset is not copied into
this submission.

```bash
npm run evaluate:mergedataset -- /path/to/mergedataset_pairs.jsonl
```

## Full repository scan

```bash
GITHUB_TOKEN=... npm run scan -- owner/repository
```

Pair merge verification uses local Git. Isolated A/B/A+B verification additionally
requires Docker. Selective LLM review requires `OPENAI_API_KEY` or
`GEMINI_API_KEY`; secrets must remain outside the repository.

## Output contract

The product-facing verdict is binary:

- `conflict`: Git text conflict or a semantic interaction signal is present.
- `no conflict`: the pair was examined and no conflict evidence was found.

Detector-specific evidence remains available in the result details for auditing.
