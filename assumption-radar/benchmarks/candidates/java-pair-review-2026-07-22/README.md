# Java PR pair review — 2026-07-22

This folder records three live open-PR pair investigations at immutable commit
SHAs. Product source code and the existing frozen benchmark were not modified
as part of these investigations.

## Summary

| Pair | Mechanical merge | Execution result | Relationship |
|---|---|---|---|
| FasterXML/jackson-databind #6045 × #5715 | clean | Base build, 59 A tests, 52 B tests, 111 union tests, and a three-run JRef + `@JsonWrapped` cross-feature probe passed | compatible candidate |
| projectlombok/lombok #3874 × #3678 | clean | A, B, and A+B each failed compilation; the failures already exist in the individual PR states | excluded single-PR regressions |
| projectlombok/lombok #4054 × #4013 | clean | Base, A, B, and A+B built; javac and all pair-relevant Eclipse tests passed | compatible candidate |

No confirmed clean pair-induced regression was found in these three pairs.

## Important boundaries

- A clean Git merge is only a precondition; it is not evidence of semantic
  compatibility by itself.
- #3874 × #3678 is not a semantic-conflict positive because both individual PR
  heads already fail compilation. It is retained as an eligibility control.
- The Eclipse 2025-03 suite reports `ValUndenotable.java` as a missing expected
  fixture in both the Lombok base state and A+B state. It is therefore a
  baseline/environment failure, not a pair-induced regression.
- Compatible candidates remain outside the frozen suite until a human approves
  the harmless causal interpretation.

## Reproduction profiles

- Jackson: Maven 3.9.11, JDK 19, companion
  `jackson-annotations` #346 at
  `d761882510737fd8166525f204c13c4b43b20efa`, version `2.23-SNAPSHOT`.
- Lombok: Apache Ant 1.10.15, JDK 11 for `dist`, JDK 19 for the available
  javac/Eclipse test matrix.
- All synthetic merges and probes were run in disposable worktrees outside the
  application repository.

