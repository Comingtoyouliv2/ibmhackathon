# Pair qualification result

- Predictions: `predictions.jsonl`
- Cases: 40 (20 conflict / 20 harmless)
- Triage precision: 90.5%
- Triage recall: 95.0%
- Triage F1: 92.7%
- Blocker precision: 100.0%
- Blocker recall: 95.0%
- False blocker rate: 0.0%
- Harmless review rate: 10.0%
- Work reduction: 47.5%
- Decisive coverage: 95.0%
- Selective accuracy: 97.4%
- Latency p50/p95: 12994.56 / 24548.10 ms

## Errors

- `caelum/vraptor4@3a85ce5195ce9267fa62376fad561df02f8f609b`: expected `conflict`, got `independent`
- `hector-client/hector@a33a46506656a39d1b0f7780973905665d3b6145`: expected `harmless`, got `review`
- `Netflix/eureka@6b09030e95e118a784ca7ec616398a4f0e384bcd`: expected `harmless`, got `review`

> Evidence and explanation correctness require blinded human adjudication and are not included in these automatic metrics.
