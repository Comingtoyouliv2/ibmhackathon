# PR Conflict Pipeline — Step 0

Fetches all open PRs from a target repo and applies rule-based filtering
(docs / format / test / dependency PRs are excluded; only logic-changing PRs
move on to Step 1).

## Setup

```bash
cd pipeline
cp .env.example .env   # put your GITHUB_TOKEN in .env
npm install
```

## Run

```bash
npm run fetch       # collect open PRs → data/prs.jsonl (resumable; Ctrl-C safe)
npm run step0       # classify + survey report → data/step0.jsonl, data/passed.jsonl, data/report.md
npm run regression  # golden-set regression against seeds/golden-set.json
```

Quick experiment on a subset first: `MAX_PRS=300 npm run fetch`

### Add a golden-set case

Snapshot a live PR (with full file pagination) and paste into `seeds/golden-set.json`:

```bash
npm run export-seed -- 101471 "Real: openclaw #101471" pass has_logic_files
```

Golden-set fixtures are **frozen snapshots** — they survive PR merge/close and are never fetched live during regression.

## Outputs

| file | contents |
|---|---|
| `data/prs.jsonl` | raw PRs, one JSON per line |
| `data/step0.jsonl` | every PR + `verdict` (`pass`/`excluded`/`deferred`) + `reason` — audit trail |
| `data/step0.csv` | Excel-friendly export with `logicChangeLines`, `signalStrength` |
| `data/passed.jsonl` | raw PRs that passed → **input contract for Step 1 (Intent Card)** |
| `data/report.md` | survey: PR-type distribution, bot share, exclusion reasons, signal strength, audit sample |
| `seeds/golden-set.json` | frozen PR snapshots for `npm run regression` |

## Step 0 improvements

- **File pagination**: PRs with >100 changed files are fully paginated via GraphQL (no truncated false negatives).
- **Config rule fix**: root-level `*.yaml`/`*.toml` are config; `src/**` application config falls through to logic.
- **Line-count hints**: `reason` includes logic file count and line counts (e.g. `has_logic_files(2 logic files, 24 logic lines / 42 total)`).
- **Signal strength**: `high` / `low` / `unknown` on each result — helps Step 1 prioritize borderline passes.
- **Golden-set regression**: 6 frozen cases (2 real openclaw PRs + 4 synthetic) run offline via `npm run regression`.

## Design decisions

- **No LLM in Step 0** — deterministic rules only, so every exclusion is auditable (`reason` field).
- **Exclude only when 100% certain**: a PR is kept if it touches even one logic file; truncated file lists (>100 files) always pass.
- **`deferred`** = has logic changes but currently git-conflicts with main. GitHub already catches those; they re-enter after rebase.
- **Bot PRs excluded** (dependabot/renovate/etc.) — recorded in the report as evidence of AI/bot PR volume.
