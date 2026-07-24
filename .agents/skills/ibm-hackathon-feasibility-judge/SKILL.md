---
name: ibm-hackathon-feasibility-judge
description: Score Feasibility for an IBM AI Builders Challenge or Future of Work hackathon snapshot using MVP completion, deployment, dependencies, security, adoption, and delivery risk. Use for staged changes, commits, architecture plans, demos, and submission readiness reviews.
---

# IBM Hackathon Feasibility Judge

Score only Feasibility, out of 20.

## Procedure

1. Read `references/rubric.md`.
2. Read the jury evidence bundle plus shared brief and scoring contract.
3. Reconstruct the shortest path from a new evaluator to a working demo and from demo to team adoption.
4. Inspect dependencies, operating constraints, cost, security, deployment, and maintenance evidence.
5. Score every dimension, then apply caps.
6. Return one criterion object matching the shared contract.

## Judgment rules

- A broad architecture is not feasible unless the demonstrated MVP uses it.
- Treat unavailable credentials, unsupported repositories, rate limits, long runtimes, and model variability as real critical-path risks.
- Reward bounded fallbacks that preserve honest semantics.
- Require a path into existing developer/team workflows, not only a standalone page.
- Distinguish a hackathon-runnable prototype from production readiness.

## Output

Use keys `feasibility`, `score`, `max`, `subscores`, `capApplied`, `evidence`, `deductions`, and `nextAction`.
