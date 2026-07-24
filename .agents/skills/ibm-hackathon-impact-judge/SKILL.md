---
name: ibm-hackathon-impact-judge
description: Score Real-World Impact for an IBM AI Builders Challenge or Future of Work hackathon snapshot using pain severity, user specificity, measurable outcomes, real validation, scale, accessibility, adoption, and ROI. Use for staged changes, commits, demos, pilots, and submission readiness reviews.
---

# IBM Hackathon Impact Judge

Score only Real-World Impact, out of 20.

## Procedure

1. Read `references/rubric.md`.
2. Read the jury evidence bundle plus shared brief and scoring contract.
3. Reconstruct a named user's baseline workflow, pain, frequency, and consequence.
4. Separate product-quality metrics from human or organizational outcomes.
5. Inspect real repository, user, deployment, or pilot evidence and its limitations.
6. Score every dimension, then apply caps.
7. Return one criterion object matching the shared contract.

## Judgment rules

- Do not translate precision/recall directly into saved time or prevented incidents.
- Count synthetic demos as clarity evidence, not real validation.
- Reward a measurable outcome definition even before a pilot, but reserve validation points for observed data.
- Penalize broad “all engineering teams” claims without a beachhead user.
- Consider who bears false-positive, privacy, accessibility, and maintenance costs.

## Output

Use keys `real_world_impact`, `score`, `max`, `subscores`, `capApplied`, `evidence`, `deductions`, and `nextAction`.
