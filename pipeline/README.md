# PR Conflict Pipeline — PR↔PR Review

This pipeline scans every open PR in a repository, removes work that should not
enter PR↔PR review, reduces the remaining pair space with a repository-local
hierarchy, and emits evidence-bounded review packets. It never treats a shared
topic alone as proof of conflict.

## Setup

```bash
cd pipeline
cp .env.example .env
npm install
```

Put a GitHub token in `.env`. Do not commit that file.

## Local web platform

```bash
npm run platform
```

Open `http://127.0.0.1:4317`. The existing OpenClaw analysis is loaded
immediately. Paste any of these forms to start a separate run:

```text
https://github.com/owner/repo.git
git clone https://github.com/owner/repo.git
git@github.com:owner/repo.git
owner/repo
```

The platform uses the GitHub API rather than checking out executable repository
code. A token entered in the page is passed only to that run's child process;
it is not written to run metadata or result files. The server binds to
`127.0.0.1` by default and stores each run under `runs/` so concurrent datasets
do not overwrite one another.

The UI provides:

- live stage, progress, and bounded logs;
- Step 0 and pair-reduction funnel;
- searchable/filterable review queue;
- sector and responsibility bucket charts;
- pair details with assumptions, resources, hypotheses, and diff excerpts;
- browser-local human `conflict` / `no conflict` / `uncertain` judgments;
- quick sample mode for testing on the most recently updated PRs.

## Full run

```bash
npm run fetch          # all open PR metadata and file lists
npm run step0          # pass / excluded / deferred
npm run pr-review      # diffs -> hierarchy -> candidates -> review packets
```

`pr-review` consumes only `data/passed.jsonl`; excluded and deferred PRs never
enter the pair search.

## Processing rule

1. **Step 0**
   - `excluded`: docs/tests/dependency automation and other certain non-logic work.
   - `deferred`: logic PR currently conflicting with main. It can re-enter after rebase.
   - `pass`: eligible for PR↔PR comparison.
2. **Sector**: coarse, multi-label repository area from GitHub labels and changed paths.
3. **Domain**: one repository-local responsibility inside each selected sector.
4. **Sub-domain**: a finer responsibility used only when a domain is still large.
5. **Touched resource**: bounded concrete contracts such as files, exported symbols,
   schema fields, config keys, RPC methods, events, or state tables.
6. **Candidate rule**
   - sector size ≤20: compare all pairs in that small sector;
   - 21–50: require a shared touched resource;
   - ≥51: require the same domain, optionally the same sub-domain, and a shared resource.
7. **Review packet**: the two intent cards, hierarchy, assumptions, behavior summaries,
   shared resources, targeted diff excerpts, and concrete questions to verify.

Explicit `stacked on` and `depends on` references are retained as dependencies.
A plain `related #...` reference does not force a pair into the queue.

## Outputs

| file | contents |
|---|---|
| `data/prs.jsonl` | all fetched open PRs |
| `data/step0.jsonl` | every Step 0 verdict and reason |
| `data/passed.jsonl` | Step 0 pass population |
| `data/report.md` | Step 0 counts and audit report |
| `data/pr-diffs.jsonl` | diff cache for passed PRs |
| `data/sectors.jsonl` | up to three coarse sector assignments per PR |
| `data/intent-cards.jsonl` | hierarchy, resources, assumptions, behavior and dependencies |
| `data/candidate-pairs-all.jsonl` | every pair that passed the adaptive retrieval gate |
| `data/candidate-pairs.jsonl` | score/budget-limited review queue |
| `data/candidate-report.md` | readable queue with potential conflicts to verify |
| `data/review-packets.jsonl` | stable IBM Bob/human review input |
| `data/review-packets.md` | readable packet index |
| `data/sector-drilldown-*.md` | hierarchy/resource reduction inside a selected sector |

The deterministic scanner produces review hypotheses, not invented conflict
verdicts. A later IBM Bob adapter should consume `review-packets.jsonl` and
return the existing `PairReview` contract: `conflict`, `no_conflict`, or
`uncertain`, with evidence. This boundary keeps candidate selection unchanged
when the reviewer is replaced.

## Controls

```bash
PAIR_BUDGET=200 npm run candidates
MAX_PAIRS_PER_PR=12 npm run candidates
MAX_RESOURCE_BUCKET=60 npm run candidates
SECTOR=core:gateway npm run sector-drilldown
```

Defaults are queue 100, eight pairs per PR, and resource buckets capped at 40.
The uncapped retrieval candidates are still written separately for evaluation.

## Closed-PR evaluation

Freeze a closed-PR snapshot, run it through the same Step 0/hierarchy/resource
code, and label both positive pairs and deliberately sampled hard negatives.
The label schema is in `seeds/pair-labels.example.jsonl`.

```bash
PAIR_LABELS_PATH=data/closed-pair-labels.jsonl \
INTENT_CARDS_PATH=data/closed-intent-cards.jsonl \
ALL_CANDIDATES_PATH=data/closed-candidate-pairs-all.jsonl \
CANDIDATES_PATH=data/closed-candidate-pairs.jsonl \
EVALUATION_REPORT_PATH=data/closed-evaluation-report.md \
npm run evaluate-pairs
```

The report separates:

- **retrieval recall**: whether sector/domain/sub-domain/resource filtering kept
  the labelled pair;
- **queue recall**: whether scoring and the review budget also kept it;
- **labelled precision**: meaningful only if hard-negative labels were sampled
  intentionally.

This prevents a poor budget setting from being mistaken for a bad retrieval
principle, and makes false negatives directly auditable.

## Verification

```bash
npm run typecheck
npm run regression
npm run audit
```

The golden Step 0 cases in `seeds/golden-set.json` are frozen and do not depend
on current GitHub state.
