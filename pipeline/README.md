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
npm run fetch    # collect open PRs → data/prs.jsonl (resumable; Ctrl-C safe)
npm run step0    # classify + survey report → data/step0.jsonl, data/passed.jsonl, data/report.md
```

Quick experiment on a subset first: `MAX_PRS=300 npm run fetch`

## Outputs

| file | contents |
|---|---|
| `data/prs.jsonl` | raw PRs, one JSON per line |
| `data/step0.jsonl` | every PR + `verdict` (`pass`/`excluded`/`deferred`) + `reason` — audit trail |
| `data/passed.jsonl` | raw PRs that passed → **input contract for Step 1 (Intent Card)** |
| `data/report.md` | survey: PR-type distribution, bot share, exclusion reasons, audit sample |

## Design decisions

- **No LLM in Step 0** — deterministic rules only, so every exclusion is auditable (`reason` field).
- **Exclude only when 100% certain**: a PR is kept if it touches even one logic file; truncated file lists (>100 files) always pass.
- **`deferred`** = has logic changes but currently git-conflicts with main. GitHub already catches those; they re-enter after rebase.
- **Bot PRs excluded** (dependabot/renovate/etc.) — recorded in the report as evidence of AI/bot PR volume.
