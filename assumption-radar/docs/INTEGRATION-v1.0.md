# Assumption Radar integration v1.0

## Product boundary

The integrated product does not claim to solve every semantic conflict. It ranks open-PR pairs that deserve joint testing, explains a possible broken assumption with bilateral code evidence, and verifies pair-induced regressions for repositories with an executable profile.

> Existing CI tests one PR at a time. Assumption Radar adds a pair-aware CI layer.

## Three code paths now connected

### Existing Assumption Radar core

- GitHub open-PR collection and all-pairs construction
- directional contract witnesses and language adapters
- current-base normalization, stack collapse, and merge-tree preflight
- conservative deterministic verdicts

### Team 1 features

- patch read/write, collection mutation, and adjacent control-flow signals
- Docker-isolated combined verification
- Base/A/B/A+B execution instead of accepting an A+B failure alone
- repeated normalized failure signature requirement

### Team 2 features

- per-PR Contract Cards and namespaced resources
- IDF/resource/intent retrieval
- compact semantic dossiers
- bounded AI second-look with bilateral verbatim evidence
- OpenAI, Anthropic, and authenticated Codex providers

The three approaches are not run as independent products and voted together. Their transferable features are connected in one funnel:

```text
collect → normalize → retrieve → deterministic witnesses → AI second-look
        → top-K Docker verification → evidence/impact JSONL → UI/CLI
```

## Executable verdicts

| Base | A | B | A+B | Repeat | Result |
|---|---|---|---|---|---|
| pass | pass | pass | pass | — | compatible |
| pass | pass | pass | fail | same failure | confirmed-conflict |
| fail | any | any | any | — | excluded |
| pass | fail | any | fail | — | excluded |
| pass | pass | pass | fail | missing/different | inconclusive |

Install failure, timeout, missing profile, and unavailable merge trees never become blockers.

## Commands

```bash
# Auto-detected Node/Python profile
npm run scan -- owner/repository --preflight --ai --ai-provider codex --verify --verify-limit 3

# Repository-specific profile
npm run scan -- owner/repository --verify \
  --verification-profile config/verification-profiles.json \
  --verification-output .cache/verification-runs/cases.jsonl
```

The web API accepts `useVerification: true`; the UI exposes the same switch. Verification is off by default because it runs untrusted repository tests and can be expensive.

## Security boundary

- tests run in disposable Docker containers
- no host credentials or Docker socket are mounted
- Linux capabilities are dropped and `no-new-privileges` is set
- CPU, memory, PID, and timeout limits are applied
- test execution uses `--network none`
- dependency installation may use the network in a separate container phase

## Evidence store

Each verified pair is appended as one compact JSON object per line. Records include immutable base/head SHAs, commands, analyzer/model metadata, structured assumptions, bilateral evidence IDs, run statuses, durations, and failure signatures. Existing events are not overwritten; reruns create new revisions.

The JSONL is the regression corpus and audit source, not the visualization itself. A later dashboard can import it into SQLite without changing the immutable evidence records.
