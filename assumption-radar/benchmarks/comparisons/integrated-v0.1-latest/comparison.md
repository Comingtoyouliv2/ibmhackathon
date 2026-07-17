# Four-system semantic-conflict comparison

> Team 2 is a runnable retrieval prototype derived from the design document. It is not the unimplemented full Step-3 LLM judge.

## Pair judgment

| System | Triage P | Triage R | F1 | Blocker P | Blocker R | False blocker | Work reduction | p50 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 94.4% | 85.0% | 89.5% | 100.0% | 85.0% | 0.0% | 55.0% | 19.4 ms |
| team1 | 80.0% | 60.0% | 68.6% | 50.0% | 5.0% | 5.0% | 62.5% | 18269.9 ms |
| team2-design-prototype | 50.0% | 100.0% | 66.7% | n/a | 0.0% | 0.0% | 0.0% | 18.0 ms |
| integrated | 94.4% | 85.0% | 89.5% | 100.0% | 85.0% | 0.0% | 55.0% | 18.2 ms |

## End-to-end radar

| System | MAP@20 | R@5 | P@5 | R@10 | P@10 | R@20 | P@20 |
|---|---:|---:|---:|---:|---:|---:|---:|
| current | 35.7% | 10.0% | 20.0% | 50.0% | 50.0% | 80.0% | 40.0% |
| team1 | 70.6% | 30.0% | 60.0% | 60.0% | 60.0% | 100.0% | 50.0% |
| team2-design-prototype | 64.4% | 30.0% | 60.0% | 55.0% | 55.0% | 100.0% | 50.0% |
| integrated | 94.3% | 50.0% | 100.0% | 85.0% | 85.0% | 100.0% | 50.0% |
