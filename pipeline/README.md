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
npm run fetch        # collect open PRs → data/prs.jsonl (resumable; Ctrl-C safe)
npm run step0        # classify + survey report → data/step0.jsonl, data/passed.jsonl, data/report.md
npm run regression   # golden-set regression against seeds/golden-set.json
```

Quick experiment on a subset first: `MAX_PRS=300 npm run fetch`

## Outputs

| file | contents |
|---|---|
| `data/prs.jsonl` | raw PRs, one JSON per line (full file list, paginated beyond 100) |
| `data/step0.jsonl` | every PR + `verdict` (`pass`/`excluded`/`deferred`) + `reason` + line stats + `signalStrength` |
| `data/step0.csv` | Excel-friendly export with `logic_files`, `logic_lines`, `total_lines`, `signal_strength` |
| `data/passed.jsonl` | raw PRs that passed → **input contract for Step 1 (Intent Card)** |
| `data/report.md` | survey: PR-type distribution, signal strength, exclusion reasons, audit sample |

## Regression (golden set)

Frozen PR snapshots in `seeds/golden-set.json` survive merge/close — regression
does not hit live GitHub. Cases include:

- Real: openclaw #101471, #95272 (known collision pair)
- Synthetic: docs-only, deps bot, `src/*.yaml` (logic), `.github`-only (config)

Add new cases with:

```bash
npm run export-seed -- 12345 "short note"
# paste output into seeds/golden-set.json, set expect + reasonIncludes
```

## Design decisions

- **No LLM in Step 0** — deterministic rules only, so every exclusion is auditable (`reason` field).
- **Exclude only when 100% certain**: a PR is kept if it touches even one logic file; truncated file lists (>100 files) are paginated and fully classified.
- **Config vs logic**: infra config (`.github/`, root `*.yml`, tooling configs) is excluded; application config under `src/` counts as logic.
- **Line hints in `reasonDetail`**: e.g. `2 logic files, 24 logic lines / 42 total` — kept out of `reason` so report aggregation stays groupable.
- **`signalStrength`** (`high`/`low`/`unknown`): Step 1 prioritization hint — low = not a pass, or a 1-file <10-line logic sliver inside a >50-line PR; high = any other pass with logic changes; unknown = file list incomplete.
- **`deferred`** = has logic changes but currently git-conflicts with main. GitHub already catches those; they re-enter after rebase.
- **Bot PRs excluded** (dependabot/renovate/github-actions only) — AI agent PRs are kept as the target population.
