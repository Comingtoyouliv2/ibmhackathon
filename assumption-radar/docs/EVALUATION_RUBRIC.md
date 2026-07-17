# Semantic Conflict Detection Rubric

## 1. 평가 철학

제품은 저장소마다 동일한 위험 점수로 PR을 판정하지 않는다. 그러나 detector와 semantic resolver를 개선하려면 고정된 평가 계약이 필요하다.

이 Rubric은 하나의 종합 점수를 만들지 않는다. 다음 질문을 별도로 측정한다.

1. 실제 conflict를 semantic review 대상으로 빠뜨리지 않았는가?
2. 자동 `conflict` 판정은 충분히 정확한가?
3. harmless pair를 사람에게 얼마나 많이 떠넘기는가?
4. 확정할 수 없을 때 제대로 abstain하는가?
5. 제시한 witness와 위치가 실제 원인을 설명하는가?
6. 특정 repo·언어·conflict 유형에만 맞춘 것은 아닌가?
7. 운영 가능한 시간과 비용 안에서 동작하는가?

## 2. 평가 단위

평가 레코드 하나는 같은 base를 가진 변경 A/B 한 쌍이다.

```json
{
  "id": "repo@scenario",
  "repo": "owner/name",
  "language": "java",
  "archetype": "behavioral-invariant",
  "distance": "same-declaration",
  "difficulty": "behavioral-reasoning",
  "gold": "conflict",
  "prediction": "review",
  "witnessTypes": ["same-declaration"],
  "evidence": {
    "grade": 2,
    "localization": "symbol",
    "rationaleComplete": true
  },
  "latencyMs": 840,
  "tokens": 4210,
  "costUsd": 0.013
}
```

Gold label은 최소 두 명의 독립 검토 또는 기존 manually analyzed dataset을 사용한다. 불일치 사례는 adjudication하고, label 근거를 별도 보존한다. `hints`와 gold rationale은 inference 입력에 넣지 않는다.

실제 PR seed에서는 raw pair와 평가 단위를 구분한다. stack pair와 stack ancestor에서 파생된 중복 conflict pair는 원본 기록으로 남기되 `relationshipBenchmarkEligibility: excluded`로 표시한다. 기계적 conflict가 확인된 coordination pair는 제품 관계 평가는 하되 `semanticBenchmarkEligibility: excluded`로 silent semantic 지표에서 분리한다. Gold와 pipeline prediction은 반드시 다른 파일에 저장한다.

## 3. Verdict 계약

| Prediction | 의미 | 기본 정책 |
|---|---|---|
| `conflict` | 양립 불가능한 witness를 확인 | merge blocker 후보 |
| `coordination` | merge-tree가 기계적 충돌 또는 순서 조율 필요성을 확인 | 제품에 표시하되 silent semantic benchmark에서 제외 |
| `review` | 상호작용은 있으나 호환 여부 미확정 | 사람·AI·AST 추가 분석 |
| `independent` | 의미적 상호작용 근거 없음 | 경고하지 않음 |
| `insufficient` | patch/context 부족 | 재수집·checkout 분석 |

## 4. 핵심 지표

### A. Candidate/Triage quality

Semantic benchmark에 포함되는 레코드에서는 `conflict`와 `review`를 candidate positive로 본다. `coordination`은 별도의 mechanical/rollout 집계로 보고 주 semantic 지표의 분모에서 제외한다.

- **Triage recall**: gold conflict 중 conflict 또는 review로 보낸 비율. 숨은 충돌 누락을 측정한다.
- **Harmless review rate**: gold harmless 중 review로 보낸 비율. 사람에게 넘기는 불필요한 부담이다.
- **Work reduction**: 전체 pair 중 independent로 안전하게 제외한 비율.

Triage recall만 높고 harmless review rate도 100%라면 detector가 아니라 전체 전달 장치에 가깝다.

### B. Automatic blocker quality

`conflict`만 blocker positive로 본다.

- **Blocker precision**: 자동 차단 중 실제 conflict 비율.
- **Blocker recall**: 실제 conflict 중 자동으로 증명한 비율.
- **False blocker rate**: gold harmless 중 conflict로 잘못 차단한 비율.

초기 단계에서는 recall보다 precision을 우선한다. `review`로 abstain할 수 있으므로 근거 없는 차단은 허용하지 않는다.

### C. Abstention quality

- **Decisive coverage**: conflict 또는 independent를 내린 비율.
- **Selective accuracy**: decisive prediction만 대상으로 한 정확도.
- **Insufficient rate**: 입력 부족으로 판정하지 못한 비율.

Coverage를 올리면서 selective accuracy가 떨어진다면 추론 범위를 지나치게 확장한 것이다.

### D. Evidence quality

사람이 각 finding의 primary witness를 다음처럼 평가한다.

- `0 invalid`: 근거가 실제 상호작용을 지지하지 않음
- `1 plausible`: 관련은 있으나 conflict 원인을 충분히 입증하지 못함
- `2 exact`: 실제 원인과 연결된 구체적인 witness

Localization 등급:

- `none`: 위치 없음
- `file`: 관련 파일만 맞음
- `symbol`: 관련 declaration/resource까지 맞음
- `line`: 원인 라인·필드·계약까지 맞음

추가 지표:

- Valid witness rate: grade 1 이상
- Exact witness rate: grade 2
- Exact localization rate: symbol 또는 line
- Rationale completeness: A의 전제, B의 전제, 모순, 결과가 모두 설명됨

### E. Cross-repository generalization

Micro 평균만 보고하지 않는다. 다음 slice의 macro 평균과 최저 slice를 함께 본다.

- repo
- primary language
- conflict archetype
- interaction distance
- difficulty

한 slice는 gold conflict가 최소 20건 이상일 때만 supported slice로 표시한다. 모델·규칙 변경 시 leave-one-repo-out 평가를 권장한다.

### F. Operations

- 분석 latency p50/p95
- PR pair당 token과 비용
- AI 없이 deterministic하게 끝난 비율
- truncated patch로 인한 insufficient 비율
- PR 10/30/100개에서 candidate 수와 총 분석 시간

### G. Detector-level heuristic quality

각 detector 또는 witness type을 독립적으로 보고한다.

- **Activations**: 해당 witness가 발동한 pair 수
- **Conflict coverage**: 전체 gold conflict 중 해당 witness가 등장한 비율
- **Harmless activation rate**: harmless pair에서 발동한 비율
- **Unique conflict contribution**: 다른 witness 없이 이 detector만 잡은 conflict 수
- **Blocker TP contribution**: 올바른 conflict 차단에 기여한 수
- **Blocker FP contribution**: 잘못된 harmless 차단에 기여한 수
- **Review yield**: review로 보낸 conflict/harmless 수

휴리스틱 변경 시 detector를 하나씩 제거하는 ablation도 실행한다. 전체 recall 변화가 없고 harmless activation만 높다면 제거 후보이며, unique conflict contribution이 크다면 언어·도메인 adapter로 정교화한다.

각 detector의 코드 테스트는 최소 다섯 종류를 가진다.

1. 명확한 positive witness
2. 같은 토큰·파일이지만 호환되는 hard negative
3. add/remove 방향을 뒤집은 counterexample
4. patch가 잘린 insufficient case
5. 지원 언어별 syntax variant

## 5. Conflict taxonomy

최소 다음 유형을 분리한다.

- API contract
- data/schema lifecycle
- event producer/consumer schema
- configuration/default
- behavioral invariant
- ordering/rollout
- resource lifecycle
- authorization
- concurrency/locking
- time, unit, precision
- serialization
- public signature
- dependency/build

거리도 `same-line → same-declaration → same-file → cross-file → cross-module → cross-service`로 분리한다. 같은 declaration 데이터만으로 범용 성능을 주장하지 않는다.

## 6. Maturity gate

`eval/rubric.json`에 초기 gate를 기계 판독 가능한 형태로 둔다. 이는 저장소 판정 임계값이 아니라 제품 출시 기준이다.

- **Triage-ready**: review assistant로 사용 가능
- **Advisory-ready**: conflict를 강한 경고로 표시 가능
- **Merge-gate-ready**: 충분한 데이터와 precision 하한을 충족할 때만 자동 차단

표본 수가 minimum data 조건보다 작으면 비율이 높아도 gate를 통과했다고 선언하지 않는다. Precision은 가능하면 Wilson 95% 하한을 사용한다.

## 7. 변경 비교 규칙

모든 heuristic 또는 prompt 변경은 동일 frozen benchmark에서 다음을 보고한다.

1. 전체 지표 전후 차이
2. 새로 잡은 conflict 목록
3. 새로 발생한 false blocker 목록
4. 해결된 review와 새로 늘어난 review
5. repo/language/archetype/distance별 회귀
6. latency·token·비용 변화
7. detector별 activation·unique contribution·ablation 변화

목표 데이터셋 한 개의 숫자만 좋아지고 다른 supported slice가 악화되면 변경을 채택하지 않는다.
