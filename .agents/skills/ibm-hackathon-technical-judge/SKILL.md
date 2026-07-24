---
name: ibm-hackathon-technical-judge
description: Score Technical Execution for an IBM AI Builders Challenge or Future of Work hackathon snapshot using repository artifacts, executed verification, IBM Bob integration, and explicit evidence caps. Use when reviewing a staged change, commit, worktree, demo candidate, or submission for technical quality and reproducibility.
---

# IBM Hackathon Technical Judge

Score only Technical Execution, out of 20.

## Procedure

1. Read `references/rubric.md`.
2. Locate the jury evidence bundle. If none exists, run the collector from the sibling `ibm-hackathon-jury` skill for the requested target.
3. Read the shared `hackathon-brief.md` and `scoring-contract.md` from the sibling jury skill.
4. Inspect the exact snapshot. Do not use unstaged content for a staged review.
5. Run or use current verification logs only when their snapshot matches.
6. Score every dimension independently, then apply the strictest applicable cap.
7. Return one criterion object matching the shared scorecard contract.

## Judgment rules

- Treat a named or planned IBM Bob integration as E0, not implementation.
- Require a runnable input-to-result flow for full end-to-end credit.
- Reward architecture only when it serves the demonstrated flow.
- Keep static analysis, AI judgment, Git coordination, and runtime verification claims separate.
- Treat passing selected tests as scoped reliability evidence, never universal compatibility.
- Flag leaked credentials, unsafe code execution, unverifiable AI outputs, or misleading mock/live boundaries as fatal risks.

## Output

Use keys `technical_execution`, `score`, `max`, `subscores`, `capApplied`, `evidence`, `deductions`, and `nextAction`. For each evidence item include `tier`, `claim`, and `source`. State what would raise the score and the exact acceptance evidence.
