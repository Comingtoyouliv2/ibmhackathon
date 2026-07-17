# Pair qualification result

- Predictions: `predictions.jsonl`
- Cases: 40 (20 conflict / 20 harmless)
- Triage precision: 94.4%
- Triage recall: 85.0%
- Triage F1: 89.5%
- Blocker precision: 100.0%
- Blocker recall: 85.0%
- False blocker rate: 0.0%
- Harmless review rate: 5.0%
- Work reduction: 55.0%
- Decisive coverage: 97.5%
- Selective accuracy: 92.3%
- Latency p50/p95: 16.15 / 911.69 ms

## Errors

- `caelum/vraptor4@3a85ce5195ce9267fa62376fad561df02f8f609b`: expected `conflict`, got `independent`
- `gwtbootstrap3/gwtbootstrap3@5c0d1eab79ec3b3d0e8c11cf7ee05e9364bbb5f1`: expected `conflict`, got `independent`
- `maxcom/lorsource@3b18a208be97c96071e2bcb4668c45c2b545bae2`: expected `conflict`, got `independent`
- `hector-client/hector@a33a46506656a39d1b0f7780973905665d3b6145`: expected `harmless`, got `review`

> Evidence and explanation correctness require blinded human adjudication and are not included in these automatic metrics.
