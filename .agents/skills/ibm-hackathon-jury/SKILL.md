---
name: ibm-hackathon-jury
description: Run an evidence-locked five-judge mock review for the IBM AI Builders Future of Work wildcard, score a staged snapshot, commit, or worktree out of 100, compare scorecards, and drive the highest-leverage improvement loop. Use at stage or commit milestones, before a demo or submission, or whenever the team asks for hackathon scoring and concrete ways to improve.
---

# IBM AI Builders Mock Jury

Score one immutable snapshot with five independent rubrics, then improve evidence without changing the rubric.

## Set the target

Use `staged` when the user asks to review staged work and the index is nonempty. Use `commit` for a named commit or `HEAD`. Use `worktree` only when explicitly reviewing uncommitted current state.

Never silently include unstaged files in a staged score. Never stage or commit files as part of judging unless asked.

## Collect evidence

From the repository root, run:

```bash
node .agents/skills/ibm-hackathon-jury/scripts/collect-evidence.mjs \
  --target staged \
  --output hackathon/judging/evidence/latest.json \
  --verify
```

For a commit, add `--target commit --commit <ref>`. For current state, use `--target worktree`.

Read completely:

- `references/hackathon-brief.md`
- `references/scoring-contract.md`
- the generated evidence bundle
- each sibling judge's `SKILL.md` and `references/rubric.md`

## Run the jury

1. Score Technical Execution and freeze it.
2. Score Innovation without altering the first result.
3. Score Feasibility.
4. Score Challenge Fit.
5. Score Real-World Impact.
6. Sum mechanically and assign the band from `references/rubric.json`.
7. Write JSON to `hackathon/judging/scorecards/<snapshot>.json`.
8. Validate and render:

```bash
node .agents/skills/ibm-hackathon-jury/scripts/validate-scorecard.mjs \
  hackathon/judging/scorecards/<snapshot>.json \
  --evidence hackathon/judging/evidence/latest.json \
  --render hackathon/judging/scorecards/<snapshot>.md
```

Call a risk `fatal` only when it can invalidate submission trust or the core demo, such as exposed secrets, fabricated evidence, unavailable core flow, or materially misleading claims.

## Improve

Prioritize changes by:

`expected points × evidence confidence ÷ implementation effort`

Prefer one product or proof change that raises multiple criteria, such as a visible Bob-assisted decision step with a reproducible demo and before/after time measurement. Do not raise scores for rubric edits, prose-only claims, or tests executed against a different snapshot.

After implementing an authorized improvement:

1. run relevant product tests;
2. stage only if the user asked;
3. collect a new snapshot;
4. rescore all five criteria from zero;
5. compare rubric hashes and totals;
6. stop when the shared target gate passes or report the remaining blocker.

Keep the previous scorecard immutable.

Compare two validated snapshots with:

```bash
node .agents/skills/ibm-hackathon-jury/scripts/compare-scorecards.mjs \
  hackathon/judging/scorecards/<before>.json \
  hackathon/judging/scorecards/<after>.json
```

## Run the isolated pre-commit loop

Use `scripts/run-precommit-loop.mjs` only for a nonempty staged snapshot. The repository Git hook calls it automatically.

The supervisor must:

1. copy the effective Git index;
2. run a fresh ephemeral read-only jury agent with structured output;
3. block implementation when allowed product paths have unstaged changes;
4. materialize the staged tree in a temporary worktree;
5. run a separate ephemeral implementation agent there;
6. reject forbidden paths, symlinks, test failures, criterion regressions, or a non-increasing total;
7. apply only an accepted patch to the candidate index;
8. repeat with a new jury context until the gate passes or the bounded iteration limit is reached;
9. publish accepted changes to the real index only after verification.

Never let either agent edit the rubric, scorecard, hook, benchmark, gold labels, package manifests, lockfiles, CI workflows, or secrets. Never fabricate IBM Bob evidence when access is unavailable.

Use `IBM_JURY_AUTOFIX=0` for jury-only blocking behavior. `IBM_JURY_MAX_ITERATIONS=<1-10>` changes the per-commit bound. Git's standard `--no-verify` and `IBM_JURY_SKIP=1` are explicit emergency bypasses and must not be used for normal scoring.
