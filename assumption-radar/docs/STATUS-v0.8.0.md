# Assumption Radar v0.8.0 상태

- 버전: `0.8.0`
- 기준일: 2026-07-15
- 제품 단계: multi-language semantic change framework foundation
- 핵심 목표: Java 규칙을 계속 추가하는 구조에서 AR-SCS/SCIR adapter 구조로 전환한다.

## 이번 버전의 결과

AR-SCS v0.1과 Semantic Change IR v0.1을 실제 runtime에 연결했다.

```text
PR diff
  → generic + language adapter
  → validated SCIR change set
  → language-independent rename/binding rules
  → conflict/review verdict
```

추가된 표준 구성:

- `docs/AR-SCS-v0.1.md`: entity, operation, dependency, assumption, evidence, verdict 정책
- `schemas/ar-scs-v0.1.schema.json`: 기계 검증용 JSON Schema
- `src/scir/index.mjs`: stable ID, IR constructor, runtime validation
- `src/adapters/registry.mjs`: 언어 감지, adapter 선택, change set 조립
- custom adapter injection: `createAnalyzer({ adapters })`, `extractSignals(pr, { adapters })`

## Adapter 현황

| Adapter | 지원 범위 | 검증 수준 |
|---|---|---|
| `generic-diff-v0.1` | declaration, call, reference, explicit/inferred rename | 기존 Java frozen + synthetic controls |
| `java-v0.1` | explicit class import와 binding requirement | Java frozen + synthetic controls |
| `python-v0.1` | `import`, `from ... import ...`, alias, replacement binding | synthetic conformance only |
| `typescript-v0.1` | default, namespace, named, aliased import | synthetic conformance only |

Python과 TypeScript는 parser가 등록되고 core conflict rule이 실제로 작동하지만, 실제 OSS 정확도는 아직 측정하지 않았다. 지원된다는 말과 검증됐다는 말을 구분해야 한다.

검증 정책도 분리했다. Java adapter의 benchmark-backed binding rule은 `conflict`로 승격할 수 있지만, Python과 TypeScript의 structural binding evidence는 실제 hard-negative 검증 전까지 `review`로만 라우팅한다. Adapter의 `deterministicEligible` metadata가 이 정책을 명시한다.

## SCIR로 이전된 규칙

### Rename vs reference

Generic adapter가 rename `operation`과 net-new reference `dependency`를 생성한다. Core는 다음 관계만 비교한다.

```text
rename(old → new) + added reference(old)
```

### Binding removal vs new use

각 언어 adapter가 자신의 import 문법을 공통 binding lifecycle로 변환한다.

```text
remove(binding X) + requires-binding(X) - replacement(binding X)
```

Core는 Java, Python, TypeScript 문법을 알지 않는다. Adapter가 `conflictEligible`, local declaration, replacement binding 등의 언어별 예외를 metadata로 제공한다.

Signature-vs-callsite와 duplicate-addition은 아직 기존 change model을 사용한다. 다음 구조 개선은 이 두 규칙도 SCIR operation/dependency query로 옮기는 것이다.

## Java frozen parity

v0.7과 동일한 40개 clean-merge benchmark에서 결과가 유지돼야 구조 변경을 채택한다.

| 지표 | v0.7.0 | v0.8.0 |
|---|---:|---:|
| Triage precision | 94.4% | **94.4%** |
| Triage recall | 85.0% | **85.0%** |
| Triage F1 | 89.5% | **89.5%** |
| Blocker precision | 100.0% | **100.0%** |
| Blocker recall | 85.0% | **85.0%** |

Parity gate는 통과했다. Triage는 `TP 17 / FP 1 / TN 19 / FN 3`, blocker FP는 0건이다. Python/TypeScript synthetic fixture는 이 표의 표본에 포함하지 않는다.

## Conformance와 안전장치

- SCIR schema/runtime version 일치
- 동일 입력의 stable ID 재현
- dangling entity/evidence reference 거부
- unsupported extension의 generic fallback
- custom adapter injection
- Java replacement import와 fully-qualified use control
- Python replacement binding control
- TypeScript aliased replacement binding control
- 기존 logger level hard negative와 moved-reference control

## 남은 일

1. Python과 TypeScript에서 실제 clean semantic positive/hard-negative를 각각 최소 20/20 수집한다.
2. Signature와 duplicate 규칙을 legacy model에서 SCIR core query로 이전한다.
3. AST/LSP resolver를 붙여 provisional entity ID를 resolved ID로 승격한다.
4. Go adapter와 OpenAPI/Protobuf/SQL contract adapter를 추가한다.
5. `language × archetype × evidence grade`별 metric을 evaluator에 추가한다.
6. structural evidence와 resolved/executable evidence의 verdict 승격 정책을 분리한다.

## 재현

```bash
npm run check
npm test
npm run build:semantic-clean -- benchmarks/semantic-clean-v0.1 benchmarks/semantic-clean-v0.1/frozen-v0.1 v0.8.0
npm run eval -- benchmarks/semantic-clean-v0.1/frozen-v0.1/predictions-v0.8.0.jsonl
```
