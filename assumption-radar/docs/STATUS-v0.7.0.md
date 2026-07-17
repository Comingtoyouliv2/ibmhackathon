# Assumption Radar v0.7.0 상태

- 버전: `0.7.0`
- 기준일: 2026-07-15
- 제품 단계: candidate miner / advisory prototype
- 이번 목표: clean merge의 `rename-vs-reference`와 `import-vs-use` dependency를 직접 증명한다.

## 변경 내용

### Inferred rename vs old reference

명시적 SQL rename 외에도 일반 코드 diff에서 반복되는 identifier 치환을 rename 후보로 복원한다.

1. 같은 hunk의 remove/add 라인을 identifier skeleton으로 정규화한다.
2. 나머지 구조는 같고 정확히 하나의 identifier mapping만 달라지는 라인을 찾는다.
3. 동일한 `old → new` 비호출 치환이 최소 2개 있어야 rename으로 인정한다.
4. 다른 PR이 같은 파일에서 old name을 net-new로 사용하거나 `.oldName` member access를 새로 추가할 때만 직접 witness를 만든다.

다음은 제외한다.

- 한 번만 나타나는 이름 교체
- 다른 PR에서 old-name 사용을 단순 이동한 경우
- `logger.info() → logger.trace()`처럼 모든 치환이 member invocation인 동작 변경
- 주석과 문자열에서만 나타나는 이름

직접 witness는 `rename-vs-old-reference`다.

### Java import removal vs new use

같은 Java 파일에서 다음 조건이 모두 성립할 때 `import-removal-vs-new-use` 직접 witness를 만든다.

- 한 PR이 명시적 non-static class import를 net-remove한다.
- 다른 PR이 그 class simple name을 코드에서 net-new로 사용한다.
- 다른 PR 또는 제거 PR이 같은 simple name의 대체 import를 제공하지 않는다.
- 다른 PR이 같은 이름의 local type 선언을 추가하지 않는다.
- 다른 PR의 사용이 fully-qualified reference가 아니다.
- `java.lang` 또는 현재 package처럼 import 없이 접근 가능한 경우가 아니다.

Wildcard와 static import는 binding 해석 없이 직접 conflict로 승격하지 않는다.

## Frozen benchmark 결과

v0.5, v0.6과 동일한 clean-merge semantic benchmark v0.1을 사용했다.

- 40 cases: positive 20 / hard negative 20
- 33 repositories
- historical Java merge만 포함

| 지표 | v0.5.0 | v0.6.0 | v0.7.0 |
|---|---:|---:|---:|
| Triage precision | 66.7% | 92.3% | **94.4%** |
| Triage recall | 10.0% | 60.0% | **85.0%** |
| Triage F1 | 17.4% | 72.7% | **89.5%** |
| Blocker precision | n/a | 100.0% | **100.0%** |
| Blocker recall | 0.0% | 60.0% | **85.0%** |
| Harmless review rate | 5.0% | 5.0% | **5.0%** |
| Work reduction | 92.5% | 67.5% | **55.0%** |

v0.7 confusion matrix:

- Triage: `TP 17 / FP 1 / TN 19 / FN 3`
- Blocker: `TP 17 / FP 0 / TN 20 / FN 3`

유일한 triage FP는 v0.6부터 존재한 `add-vs-add` compatible-refactoring review다. 새 rename/import detector가 만든 hard-negative blocker FP는 없다.

### 목표 사례

- `sanity/tahrir`: `location → physicalLocation`과 다른 PR의 `address.location` 추가 검출
- `timmolter/XChart`: `stylerXY → xyStyler`와 다른 PR의 `stylerXY` 추가 검출
- `ninjaframework/ninja`: `Cookie` import 제거와 다른 PR의 `new Cookie(...)` 추가 검출

같은 관계 구조를 가진 `AsyncHttpClient`와 `yegor256/s3auth` 양성도 추가로 회수했다. 따라서 v0.6 대비 FN 5건이 감소했다.

## 남은 오류

FN은 3건이다.

- behavioral composition 2건
- remove-vs-reference 1건

FP는 기존 `add-vs-add` review 1건이다. 다음 우선순위는 일반 이름 문자열 규칙을 넓히는 것보다 다음 두 방향이 적합하다.

1. declaration removal과 typed/member reference를 연결하는 보수적인 `remove-vs-reference`
2. 두 PR의 값을 함께 적용해야만 깨지는 behavioral composition을 통합 테스트 또는 제한된 dataflow로 검증

## 한계

- rename inference는 AST symbol resolution이 아니라 반복 치환 증거다.
- method rename은 member invocation을 오탐 방지상 제외하므로 아직 직접 잡지 않는다.
- import detector는 현재 Java의 explicit class import만 지원한다.
- wildcard, static import, Kotlin alias, TypeScript re-export, Python import alias는 미지원이다.
- frozen set이 Java에 편향되어 다른 언어 일반화를 주장할 수 없다.
- 40건은 방향 비교에는 유효하지만 confidence interval이 넓으므로 자동 merge gate 근거로는 부족하다.

## 검증 및 재현

```bash
npm test
npm run check
npm run build:semantic-clean -- benchmarks/semantic-clean-v0.1 benchmarks/semantic-clean-v0.1/frozen-v0.1 v0.7.0
npm run eval -- benchmarks/semantic-clean-v0.1/frozen-v0.1/predictions-v0.7.0.jsonl
```

관련 산출물:

- `benchmarks/semantic-clean-v0.1/frozen-v0.1/predictions-v0.7.0.jsonl`
- `benchmarks/semantic-clean-v0.1/frozen-v0.1/metrics-v0.7.0.json`
- `benchmarks/semantic-clean-v0.1/frozen-v0.1/report-v0.7.0.md`
- `benchmarks/semantic-clean-v0.1/frozen-v0.1/error-ledger-v0.7.0.jsonl`
