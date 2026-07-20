# Assumption Radar pull request review

Review the pull request merge result against its base branch. This is a read-only
review: do not edit files, commit, push, or call external services.

Report only actionable defects introduced by this pull request. Prioritize
correctness, security, data loss, unsafe automation, performance regressions,
and missing tests that allow a concrete regression. Ignore style preferences and
pre-existing issues. For every finding, include:

- severity (`P0` critical, `P1` high, `P2` medium, or `P3` low),
- the smallest relevant file and line range,
- a concrete failure scenario,
- why the current tests or safety gates do not prevent it.

Apply these project-specific invariants:

1. A confirmed pair-induced regression requires Base, PR A, and PR B to pass
   independently while A+B fails for a repeatable, pair-caused reason. Install
   failures, timeouts, flaky failures, and independent single-PR failures are
   inconclusive rather than semantic conflicts.
2. Automated improvement candidates may change only the explicitly allowed
   source file and focused test. Reject changes to benchmarks, gold labels,
   configuration, package scripts, unrelated files, symlinks, or file modes.
3. Candidate evaluation must use an isolated workspace, preserve the original
   repository, and re-check the exact candidate state immediately before apply.
4. Frozen benchmark and full tests must not regress. Do not accept a higher score
   obtained by changing the benchmark, labels, denominators, or routing semantics.
5. Live OSS evidence must be tied to immutable SHAs. Stack/ancestor pairs and
   textual merge conflicts must not be counted as clean semantic-conflict cases.
6. Missing predictions, unstable repeated AI answers, and changed PR SHAs must be
   routed explicitly; they must not silently become passes or confirmed labels.

If there are no actionable findings, respond exactly:

`No actionable findings.`
