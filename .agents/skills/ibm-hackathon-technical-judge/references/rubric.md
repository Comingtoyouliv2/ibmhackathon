# Technical Execution rubric — 20 points

| Dimension | Max | Full-credit evidence |
|---|---:|---|
| End-to-end functionality | 5 | A judge can reproduce the core input → AI/analysis → decision/output flow; failure states are honest. |
| IBM Bob integration | 4 | Bob performs a necessary, visible task in the live flow; inputs, outputs, and fallback are inspectable. |
| Architecture and engineering depth | 4 | Coherent data flow, justified technical choices, nontrivial implementation, and clean component contracts support the demo. |
| Validation, reliability, and security | 5 | Current tests/benchmarks cover positive and negative paths; claims match scope; secrets, untrusted code, and AI uncertainty are controlled. |
| Demo operability | 2 | Setup is short and reliable; a fallback exists without disguising mocks as live results. |

Apply the lowest relevant cap:

- No reproducible core flow: 8/20.
- Materially mocked flow presented as live: 10/20.
- IBM Bob only named or planned: 16/20.
- Critical security/secret-handling failure: 10/20.

Common deductions:

- `-1 to -3`: stale or contradictory setup/status documentation.
- `-1 to -3`: tests exist but no current execution evidence.
- `-1 to -4`: headline performance claim lacks a frozen input, baseline, or reproducible command.
- `-1 to -4`: AI verdict has no cited source evidence or calibrated uncertainty.
