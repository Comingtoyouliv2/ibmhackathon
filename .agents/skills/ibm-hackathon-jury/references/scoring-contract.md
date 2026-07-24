# Mock-jury scoring contract

## Evidence ladder

Give credit only at the strongest demonstrated tier:

| Tier | Meaning | Typical evidence |
|---|---|---|
| E0 | Claim only | roadmap, proposed design, unsupported README statement |
| E1 | Inspectable artifact | checked-in code, UI, architecture, test, demo data |
| E2 | Executed evidence | current command log, passing test, reproducible benchmark |
| E3 | Independent/repeated evidence | frozen benchmark, repeat run, external repository case, failure controls |
| E4 | Outcome evidence | user test, deployment usage, time/cost/error reduction, adoption |

An E0 claim may explain intent but cannot prove implementation, feasibility, or impact. Selected passing tests prove only no observed failure in their covered scope.

## Snapshot integrity

Score exactly one target:

- `staged`: HEAD plus index; ignore unstaged content.
- `commit`: the named commit tree.
- `worktree`: tracked and untracked files explicitly listed by the evidence collector.

Record the target identity and rubric hash. Do not compare scorecards with different rubric hashes as if they were a continuous trend.

If verification ran against a different snapshot, label it contaminated and do not award E2 credit from it.

## Anti-halo procedure

1. Score all dimensions for one criterion without viewing the desired total.
2. Apply criterion caps.
3. Cite both positive and missing evidence.
4. Freeze that criterion result before scoring the next criterion.
5. Sum mechanically; never backsolve scores to reach a target band.

## Missing evidence

- Treat absent evidence as zero for the affected dimension, not as an assumption that the feature probably works.
- Distinguish `not implemented`, `not verified`, and `not discoverable in the judged snapshot`.
- Do not award the same artifact twice unless it independently proves two different claims.
- Treat synthetic demo data as product-demonstration evidence, not real-world outcome evidence.
- Treat detector precision/recall as Technical evidence. Count it as Impact evidence only when translated into a measured human or organizational outcome.

## Bands and iteration gate

| Total | Mock-jury interpretation |
|---:|---|
| 90–100 | Winner-ready evidence package |
| 80–89.5 | Finalist-ready, with limited exposed risk |
| 70–79.5 | Competitive concept, material proof gaps |
| 60–69.5 | Promising prototype |
| below 60 | Not submission-ready |

The default improvement target is at least 85/100, no criterion below 15/20, no fatal risk, a reproducible end-to-end demo, and implemented IBM Bob value that is visible in the demo. This is a mock-jury target, not an official cutoff.

## Required scorecard shape

Each criterion result must contain:

- numeric `score` and `max`
- dimension-level `subscores`
- `capApplied` or `null`
- evidence citations with tier and repository path/command
- deductions or missing proof
- one highest-leverage next action with acceptance evidence

The combined scorecard must add snapshot identity, total, band, fatal risks, and three prioritized improvements with expected point ranges. Expected gains are hypotheses, not guaranteed points.
