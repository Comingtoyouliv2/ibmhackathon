# Execution

- System: Contract Radar Codex Evaluator
- Version: contract-radar-v0.4 / codex-cli 0.135.0
- Model: gpt-5.4
- Reasoning effort: medium
- Pair policy: one isolated read-only Codex call per input record
- End-to-End policy: one isolated read-only Codex call per episode; all 780 pairs considered
- Retry policy: no semantic-output retries or test-time tuning. Cases 19, 24,
  and 38 were reissued once only because their unchanged JSON exceeded the CLI
  transport limit; the complete records were mounted read-only as `case.json`.
- Tokens/cost: unavailable from this Codex CLI surface, recorded as null
- Required environment variables: none; existing Codex CLI authentication is required

## Commands

```bash
node run-codex-evaluation.mjs pair 1 1
node run-codex-evaluation.mjs pair 2 10
node run-codex-evaluation.mjs pair 11 20
node run-codex-evaluation.mjs pair 21 30
node run-codex-evaluation.mjs pair 31 40
node run-codex-evaluation.mjs e2e 1
node run-codex-evaluation.mjs e2e 2

# Exact transport-only recovery after the three oversized calls failed before a model turn
node run-codex-evaluation.mjs pair 19 20
node run-codex-evaluation.mjs pair 24 30
node run-codex-evaluation.mjs pair 38 40

node run-codex-evaluation.mjs assemble
```
