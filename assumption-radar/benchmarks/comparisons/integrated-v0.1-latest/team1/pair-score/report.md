# Pair qualification result

- Predictions: `predictions.jsonl`
- Cases: 40 (20 conflict / 20 harmless)
- Triage precision: 80.0%
- Triage recall: 60.0%
- Triage F1: 68.6%
- Blocker precision: 50.0%
- Blocker recall: 5.0%
- False blocker rate: 5.0%
- Harmless review rate: 10.0%
- Work reduction: 62.5%
- Decisive coverage: 67.5%
- Selective accuracy: 66.7%
- Latency p50/p95: 18269.94 / 37484.70 ms

## Errors

- `caelum/vraptor4@3a85ce5195ce9267fa62376fad561df02f8f609b`: expected `conflict`, got `independent`
- `caelum/vraptor4@eff0f0cec9d5ff971bb6b95fc79aa608f3b68726`: expected `conflict`, got `independent`
- `essentials/Essentials@06334f9b484d6e8d8ca2291e91462066cbcc57d2`: expected `conflict`, got `independent`
- `ninjaframework/ninja@94b2365be30bfa5b88f2d6c2f0097ad438426198`: expected `conflict`, got `independent`
- `Spoutcraft/Spoutcraft@9c6973d44311958d43b4cb6073c58b9466dcafb0`: expected `conflict`, got `independent`
- `tinkerpop/rexster@fd1733b8ed502f24fd844e235e6dff88ccdc3cd3`: expected `conflict`, got `independent`
- `xtreemfs/xtreemfs@432c7e4273cbc3e86b24204f4fa9a8a80ac69764`: expected `conflict`, got `independent`
- `yegor256/s3auth@b8bcb4a244f4048c84b744d2f7a88094ee419d5c`: expected `conflict`, got `independent`
- `atmosphere/atmosphere@ffc0c6e274094c6423e29d1c45bab1593b8fac7d`: expected `harmless`, got `review`
- `jchambers/pushy@58901c846e4f0874977c5aabbc34bcb4de3670e0`: expected `harmless`, got `review`
- `Netflix/SimianArmy@345ad9513aafff397050d613fa87ad06ddffe99d`: expected `harmless`, got `conflict`

> Evidence and explanation correctness require blinded human adjudication and are not included in these automatic metrics.
