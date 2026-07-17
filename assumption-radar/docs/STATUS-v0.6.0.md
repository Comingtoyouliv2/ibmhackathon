# Assumption Radar v0.6.0 상태

- 버전: `0.6.0`
- 기준일: 2026-07-15
- 제품 단계: candidate miner / advisory prototype
- 이번 목표: clean merge에서 `signature-vs-callsite`와 `duplicate-addition` 양성을 직접 증명하는 규칙을 추가한다.

## 변경 내용

### Signature vs callsite

PR A가 callable의 인자 수를 바꾸고 PR B가 이전 인자 수의 호출을 새로 추가하면 `signature-change-vs-old-call` 직접 witness를 만든다.

- hunk의 context를 보존해 old/new 코드 조각을 각각 재구성한다.
- Java처럼 여러 줄로 작성된 method·constructor 선언과 호출도 최대 16줄 범위에서 복원한다.
- 이름뿐 아니라 이전 arity와 새 arity를 비교한다.
- 다른 PR에서 단순히 위치만 옮긴 호출은 add/remove를 상쇄해 새 callsite로 오인하지 않는다.
- 같은 hunk anchor의 old/new 선언만 signature change로 묶어 overload 간 교차 매칭을 줄인다.

### Duplicate addition

두 PR이 같은 파일의 서로 다른 base anchor에 동일 declaration identity를 각각 추가하면 `duplicate-declaration-addition` 직접 witness를 만든다.

- type은 이름, method·constructor는 이름과 arity, field·constant는 이름으로 identity를 만든다.
- visibility가 달라도 같은 constant 이름이면 중복으로 본다.
- 동일 base anchor의 추가는 clean semantic conflict로 판정하지 않는다. Git preflight가 먼저 다룰 영역이다.
- 서로 다른 overload arity는 별도 선언으로 취급한다.
- 어느 한쪽이 base declaration을 교체한 경우는 순수 duplicate-addition에서 제외한다.

일반적인 symbol removal 규칙은 오탐을 막기 위해 대문자로 시작하는 type 제거와 새 참조에만 제한했다. 함수·field 제거를 이름 문자열만으로 직접 충돌 처리하지 않는다.

## Frozen benchmark 결과

입력은 v0.5와 동일한 clean-merge semantic benchmark v0.1이다.

- 40 cases: positive 20 / hard negative 20
- 33 repositories
- 모두 historical Java merge
- v0.5 파일은 보존하고 v0.6 prediction, metrics, report, error ledger를 별도 생성한다.

| 지표 | v0.5.0 | v0.6.0 | 변화 |
|---|---:|---:|---:|
| Triage precision | 66.7% | 92.3% | +25.6%p |
| Triage recall | 10.0% | 60.0% | +50.0%p |
| Triage F1 | 17.4% | 72.7% | +55.3%p |
| Blocker precision | n/a | 100.0% | 12/12 정밀 적중 |
| Blocker recall | 0.0% | 60.0% | +60.0%p |
| Harmless review rate | 5.0% | 5.0% | 변화 없음 |
| Work reduction | 92.5% | 67.5% | 더 많은 실제 양성을 검토 대상으로 회수 |

Confusion matrix 기준으로 triage는 `TP 12 / FP 1 / TN 19 / FN 8`이다. Blocker는 `TP 12 / FP 0`이다. 유일한 triage FP는 기존 `add-vs-add` review 규칙이 올린 compatible refactoring이며, 이번 두 detector가 새로 만든 hard-negative FP는 없다.

### 목표 슬라이스

- `signature-vs-callsite`: 5/5를 모두 `conflict`로 검출
- 실제 `duplicate-addition`: 4/4를 모두 `conflict`로 검출

Gold의 자동 archetype 필드에서 duplicate-addition으로 표시된 다섯 번째 `yegor256/s3auth` 표본은 rationale상 class rename 대 old-name reference다. 따라서 duplicate detector의 FN이 아니라 benchmark metadata의 분류 오류이며, rename/reference 후속 슬라이스에서 다룬다.

## 남은 한계

- 현재 frozen benchmark는 Java만 포함하므로 Python, TypeScript, Go 등의 문법 일반화는 증명되지 않았다.
- 같은 arity 안에서 parameter type·순서·optional/default 의미만 바뀌는 signature conflict는 아직 직접 잡지 못한다.
- duplicate variable은 명시적 modifier가 있는 field·constant 중심이다. 임의 local variable은 scope를 AST로 확인하지 않으면 오탐 위험이 있어 승격하지 않는다.
- rename/reference, import/use, remove/reference, behavioral composition 8건은 여전히 FN이다.
- pair 생성은 여전히 `O(n²)`이고 대형 저장소용 resource 역색인은 아직 없다.
- 현재 결과는 advisory 품질 평가이며 자동 merge gate로 사용할 근거는 부족하다.

## 검증 및 재현

```bash
npm test
npm run check
npm run build:semantic-clean -- benchmarks/semantic-clean-v0.1 benchmarks/semantic-clean-v0.1/frozen-v0.1 v0.6.0
npm run eval -- benchmarks/semantic-clean-v0.1/frozen-v0.1/predictions-v0.6.0.jsonl
```

관련 산출물:

- `benchmarks/semantic-clean-v0.1/frozen-v0.1/predictions-v0.6.0.jsonl`
- `benchmarks/semantic-clean-v0.1/frozen-v0.1/metrics-v0.6.0.json`
- `benchmarks/semantic-clean-v0.1/frozen-v0.1/report-v0.6.0.md`
- `benchmarks/semantic-clean-v0.1/frozen-v0.1/error-ledger-v0.6.0.jsonl`
