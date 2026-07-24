---
name: ibm-hackathon-innovation-judge
description: Score Innovation for an IBM AI Builders Challenge or Future of Work hackathon snapshot, separating a novel problem insight and defensible workflow from generic AI wrapping or pitch-only novelty. Use for staged changes, commits, demos, product concepts, and submission readiness reviews.
---

# IBM Hackathon Innovation Judge

Score only Innovation, out of 20.

## Procedure

1. Read `references/rubric.md`.
2. Read the jury evidence bundle plus the shared brief and scoring contract.
3. Inspect the exact target snapshot and identify the product's one-sentence insight.
4. Compare the actual workflow with the obvious baselines: manual work, Git/CI checks, code-review tools, and generic LLM review.
5. Score dimensions before applying caps.
6. Return one criterion object matching the shared contract.

## Judgment rules

- Reward a new useful workflow or decision boundary, not terminology.
- Require artifact evidence that the novel mechanism exists.
- Give differentiation credit only for specific baseline limitations and a demonstrated advantage.
- Reward honest negative results, abstention, and learning loops when they improve trust.
- Reserve demo “aha” credit for a moment a judge can see in under two minutes.

## Output

Use keys `innovation`, `score`, `max`, `subscores`, `capApplied`, `evidence`, `deductions`, and `nextAction`.
