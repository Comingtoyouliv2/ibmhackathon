# Pair qualification result

- Predictions: `predictions.jsonl`
- Cases: 40 (20 conflict / 20 harmless)
- Triage precision: 90.9%
- Triage recall: 100.0%
- Triage F1: 95.2%
- Blocker precision: 100.0%
- Blocker recall: 100.0%
- False blocker rate: 0.0%
- Harmless review rate: 10.0%
- Work reduction: 45.0%
- Decisive coverage: 95.0%
- Selective accuracy: 100.0%
- Latency p50/p95: 0.00 / 0.00 ms

## Errors

- `hector-client/hector@a33a46506656a39d1b0f7780973905665d3b6145`: expected `harmless`, got `review`
- `richardwilly98/elasticsearch-river-mongodb@6b6ce8e851c6613213c4508c3f277a80649e0c7b`: expected `harmless`, got `review`

> Evidence and explanation correctness require blinded human adjudication and are not included in these automatic metrics.
