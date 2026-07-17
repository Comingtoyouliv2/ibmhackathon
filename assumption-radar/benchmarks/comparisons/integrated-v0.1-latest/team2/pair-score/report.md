# Pair qualification result

- Predictions: `predictions.jsonl`
- Cases: 40 (20 conflict / 20 harmless)
- Triage precision: 50.0%
- Triage recall: 100.0%
- Triage F1: 66.7%
- Blocker precision: n/a
- Blocker recall: 0.0%
- False blocker rate: 0.0%
- Harmless review rate: 100.0%
- Work reduction: 0.0%
- Decisive coverage: 0.0%
- Selective accuracy: n/a
- Latency p50/p95: 17.96 / 923.82 ms

## Errors

- `Activiti/Activiti@bf46684ba62f5883673ea8fb0a14aecfe0aedea2`: expected `harmless`, got `review`
- `atmosphere/atmosphere@ffc0c6e274094c6423e29d1c45bab1593b8fac7d`: expected `harmless`, got `review`
- `elastic/elasticsearch@36884807b3cc9d660db4da062275c7fdbec8ba67`: expected `harmless`, got `review`
- `elastic/elasticsearch@3764b3ff800c94293aba0bb0fa18c7df80a764f7`: expected `harmless`, got `review`
- `hector-client/hector@0588608e7a2bdf974c985ff546207104f672bf6c`: expected `harmless`, got `review`
- `hector-client/hector@213f7887ea70eabdf0705cf8454de29af89e8c38`: expected `harmless`, got `review`
- `hector-client/hector@a33a46506656a39d1b0f7780973905665d3b6145`: expected `harmless`, got `review`
- `jchambers/pushy@58901c846e4f0874977c5aabbc34bcb4de3670e0`: expected `harmless`, got `review`
- `libgdx/libgdx@da27e2dae56be0a159e82231e5c3a5b83b099063`: expected `harmless`, got `review`
- `metamx/druid@05168808c278c080c59c19e858d9471b316cd1f5`: expected `harmless`, got `review`
- `Netflix/eureka@6b09030e95e118a784ca7ec616398a4f0e384bcd`: expected `harmless`, got `review`
- `Netflix/SimianArmy@345ad9513aafff397050d613fa87ad06ddffe99d`: expected `harmless`, got `review`
- `richardwilly98/elasticsearch-river-mongodb@6b6ce8e851c6613213c4508c3f277a80649e0c7b`: expected `harmless`, got `review`
- `spring-projects/spring-boot@2d4e68a9777601bfb8309c94d8b74bc21be80ad1`: expected `harmless`, got `review`
- `square/okhttp@1151c9853ccc3c9c3211c613b9b845b925f8c6a6`: expected `harmless`, got `review`
- `square/okhttp@35166168529bd27281685e56a0a122eff44460e9`: expected `harmless`, got `review`
- `square/retrofit@2b6c719c6645f8e48dca6d0047c752069d321bc4`: expected `harmless`, got `review`
- `thinkaurelius/titan@387c16ea05ef9fa312f37139228d2bbf61455ff4`: expected `harmless`, got `review`
- `antlr/antlr4@69ff2669eec265e25721dbc27cb00f6c381d0b41`: expected `harmless`, got `review`
- `unclebob/fitnesse@4d9ba9d221d879507440feb084fa7521b95111ec`: expected `harmless`, got `review`

> Evidence and explanation correctness require blinded human adjudication and are not included in these automatic metrics.
