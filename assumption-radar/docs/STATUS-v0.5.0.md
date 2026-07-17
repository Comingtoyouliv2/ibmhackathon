# Assumption Radar v0.5.0 상태

- 버전: `0.5.0`
- 기준일: 2026-07-15
- 제품 단계: candidate miner / advisory prototype
- 목표: open PR이 merge되기 전에 서로의 숨은 전제가 충돌하는 지점을 찾아 근거와 조치까지 설명한다.

## 이번 버전의 경계

v0.5.0은 v0.4의 causal witness와 coordination explainer에 base-normalized Git preflight를 추가한 버전이다.

1. 각 PR의 diff를 add/remove 방향이 보존된 change model로 변환한다.
2. API, schema, event, config, rename, declaration, file lifecycle witness를 생성한다.
3. 같은 파일·선언이라는 관련성과 실제 dependency·composition·contradiction 증거를 분리한다.
4. stack ancestor PR을 최신 descendant에 접는다.
5. 각 PR을 동일한 최신 target base에 적용한 virtual merge commit을 만든다.
6. virtual result끼리 `git merge-tree`로 비교한다.
7. clean merge의 causal `review` 후보만 선택적으로 AI semantic resolver에 전달한다.

Raw PR head끼리 직접 병합하지 않는다. 서로 다른 시점에 갈라진 base history가 두 PR의 충돌처럼 되살아날 수 있기 때문이다. 개별 PR이 현재 base와 먼저 충돌하면 관련된 모든 pair를 반복 경고하지 않고 `insufficient / base-conflict`로 보류한다.

## Verdict 계약

| Verdict | 의미 | 정책 |
|---|---|---|
| `conflict` | 양립 불가능한 직접 계약 witness가 있음 | blocker 후보, AI가 제거할 수 없음 |
| `coordination` | 두 base-normalized 결과 사이에 Git 충돌이 있음 | 조율 대상으로 표시, silent semantic benchmark에서 제외 |
| `review` | dependency 또는 composition-risk가 있으나 호환성 미확정 | AI·사람·통합 테스트로 확인 |
| `independent` | causal proof 없이 relevance/proximity만 있음 | 경고하지 않음 |
| `insufficient` | patch 누락, base conflict 또는 preflight 불가 | 재수집·rebase·checkout 요청 |

## 현재 잡는 semantic conflict 표면

자동 `conflict`로 증명하는 영역:

- 동일 public declaration의 서로 다른 signature 교체
- API, DB field, event, environment variable, feature flag 제거와 새 사용의 충돌
- rename 뒤 다른 PR이 이전 이름을 새 코드에서 참조
- event producer payload가 consumer의 필수 field를 제공하지 않음
- 같은 config/flag에 서로 다른 default 값을 선언

`review` 후보로 올리는 영역:

- file delete 대 modify
- 같은 새 경로 add 대 add
- 같은 기존 구현의 competing replacement
- 같은 schema/table의 구조 변경과 접근
- 같은 event producer/consumer의 동시 변경
- 같은 계약 표면의 중복 정의

같은 파일, 같은 hunk, 같은 declaration만으로는 경고하지 않는다. 한 PR의 변경이 다른 PR의 실패 조건에 도달한다는 causal witness가 필요하다.

## 현재 잘 못 잡는 영역

- call graph와 dataflow를 따라야 하는 cross-file/cross-module 동작 충돌
- authorization 및 branch-protection 규칙의 우선순위
- 상태 전이, 반환값 의미, 예외 처리와 transaction 경계
- concurrency, locking, ordering
- time/unit/precision, serialization 호환성
- 테스트를 실제로 함께 실행해야만 드러나는 behavioral invariant
- 언어별 AST가 필요한 Go, Rust, C++ 등의 정교한 symbol 관계

현재 AI resolver는 heuristic이 `review`로 올린 쌍만 본다. 후보 생성에서 누락한 pair를 AI가 복구할 수 없으므로 recall의 주 병목은 candidate generation이다. Semantic AI 응답의 evidence도 아직 입력 evidence ID만 선택하도록 제한되지 않고 자유 문자열을 허용한다.

## 검증 결과

### 자동 회귀 테스트

- Node test: 30/30 통과
- syntax check: 통과
- 검증 대상: directional extraction, causal roles, deterministic conflicts, hard negative, evaluator, coordination subtype/action, stack collapse, base-normalized merge-tree, base-conflict abstention

이 테스트는 규칙의 동작을 보장하지만 실제 저장소 정확도를 증명하지 않는다.

### Scikit-learn adjudicated seed

마지막 frozen baseline은 `baseline-v0.4.0`이며 v0.5에서도 회귀 anchor로 보존한다.

- raw cases: 5
- 독립 관계 평가 대상: 3
- stack/alias filter recall: 2/2
- exact relationship: 3/3
- coordination recall: 2/2
- coordination subtype/action: 2/2
- clean compatible: 1/1
- 검증된 clean semantic conflict positive: 0

따라서 표시된 100%는 소수 coordination/compatible 회귀 사례에만 해당한다. Semantic conflict precision, recall 및 cross-repository accuracy는 아직 계산할 수 없다.

### Clean-merge semantic benchmark v0.1

실제 historical merge를 재생해 20 positive와 20 hard negative를 고정했다.

- 40 cases, 33 repositories
- 모두 Git textual conflict가 없는 clean merge
- positive 20건은 자동 merge tree가 기록된 merge tree와 일치
- positive 20건은 원인을 수리하는 descendant fixing commit과 contract-level 인과 설명 보유
- hard negative 20건은 같은 선언·상태·control-flow를 양쪽이 수정했지만 기대를 깨지 않는 사례

| v0.5.0 결과 | 값 |
|---|---:|
| Triage precision | 66.7% |
| Triage recall | 10.0% |
| Triage F1 | 17.4% |
| Blocker recall | 0.0% |
| Harmless review rate | 5.0% |
| Work reduction | 92.5% |

실제 양성 20건 중 `review`로 올린 것은 2건이고 18건을 `independent`로 놓쳤다. 주요 FN은 signature 변경 대 새 call site, rename 대 이전 이름 참조, import 제거 대 새 사용, 초기화 순서, 중복 선언이다. 반대로 hard negative는 20건 중 19건을 경고 없이 제외했다. 따라서 v0.5.0의 핵심 병목은 precision이 아니라 candidate-generation recall이다.

이 frozen set은 모두 historical Java merge다. 최초 성능 baseline으로는 유효하지만 cross-language 또는 현재 open PR 분포의 일반화를 증명하지 않는다.

### Gitea frozen open-PR run

입력: 28 code PR, 378 pair.

| 결과 | 수 | 전체 pair 대비 |
|---|---:|---:|
| `coordination` | 24 | 6.3% |
| `independent` | 327 | 86.5% |
| `insufficient` | 27 | 7.1% |
| clean semantic `review` | 0 | 0% |
| deterministic semantic `conflict` | 0 | 0% |

Preflight는 interaction signal이 있는 122 pair를 검사했다. 그중 clean 59, pair textual conflict 24, individual base-conflict가 전파된 pair 27, unavailable 12였다. Raw-head preflight의 62 alerts는 base normalization 후 24로 61.3% 감소했다.

이 결과에는 아직 gold label이 없으므로 24건의 precision이나 누락된 semantic conflict recall을 의미하지 않는다. 대표 5건을 별도 검증 큐로 선정했다.

## 효율성

현재 30 PR 수준에서는 실용적이다.

- heuristic mode에서는 AI token 비용이 없다.
- AI는 clean `review`만, 한 실행 최대 20 pair에 사용한다.
- Gitea run은 378 pair 중 327 pair를 사용자 경고 없이 제외했다.
- merge-tree는 모든 pair가 아니라 interaction witness가 있는 pair에만 실행한다.

하지만 pair 생성 자체는 `O(n²)`이다.

| Open PR | Pair 수 |
|---:|---:|
| 30 | 435 |
| 100 | 4,950 |
| 500 | 124,750 |
| 1,000 | 499,500 |

수백 개 이상의 PR에서는 파일·symbol·contract 역색인으로 interaction graph를 먼저 만들고 연결된 PR만 비교해야 한다. 현재 run artifact에는 latency p50/p95, token, 비용도 기록되지 않아 운영 효율의 시간 기반 비교는 아직 불가능하다.

## 현재 판단

| 항목 | v0.5.0 평가 |
|---|---|
| stack/base/Git conflict 분리 | 검증됨 |
| 명시적 contract lifecycle 규칙 | 구현됨, 실전 precision 미측정 |
| 동일 파일 노이즈 억제 | 구현됨 |
| coordination 설명 | 소수 seed에서 검증됨 |
| behavioral semantic recall | 20건 frozen set에서 triage 10.0% |
| cross-repository generalization | Java 33개 repo에서 1차 측정, 다른 언어 미검증 |
| 30 PR 규모 | candidate mining에 사용 가능 |
| 수백 PR 규모 | 아직 부적합 |
| 자동 merge gate | 사용 불가 |
| 사람 검수용 advisory | 제한적으로 사용 가능 |

## v0.6으로 넘어가기 위한 조건

1. frozen 20개 FN을 `signature/call`, `rename/reference`, `import/use`, `initialization`, `duplicate` 오류 장부로 분류한다.
2. 가장 큰 FN 유형부터 language adapter와 directional dependency detector를 추가한다.
3. Python·Go 등 2개 이상 언어에서 positive/hard-negative를 추가해 Java 편향을 줄인다.
4. Gitea 대표 5건을 독립 검증하고 gold/error ledger에 편입한다.
5. evidence ID 선택 인터페이스와 latency/token/cost 기록을 구현한다.
6. pair 전체 생성 전에 resource 역색인 candidate graph를 추가한다.

이 조건 전에는 seed의 100%를 제품 정확도로 표현하지 않는다.

## 재현 명령

```bash
npm test
npm run check
npm run eval:seed
npm run import:scam
npm run build:semantic-clean
npm run eval -- benchmarks/semantic-clean-v0.1/frozen-v0.1/predictions-v0.5.0.jsonl
npm run mine -- go-gitea/gitea --limit 30 --controls 8 --preflight
```

관련 자료:

- `docs/FRAMEWORK.md`
- `docs/EVALUATION_RUBRIC.md`
- `benchmarks/adjudicated/scikit-learn-seed-v0.1/`
- `benchmarks/semantic-clean-v0.1/frozen-v0.1/`
- `benchmarks/candidates/go-gitea__gitea-v0.5.0/`
- `benchmarks/candidates/go-gitea__gitea-2026-07-15-base-normalized/triage-selection.md`
