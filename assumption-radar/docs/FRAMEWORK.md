# Assumption Radar Framework

## 설계 원칙

이 프레임워크는 모든 저장소에 같은 숫자와 임계값을 적용하지 않습니다. 대신 각 판정이 답해야 하는 질문을 고정합니다.

1. 두 PR 사이에 어떤 구체적인 상호작용 표면이 있는가?
2. 그 표면에서 동시에 성립할 수 없는 변경을 증명할 수 있는가?
3. 증명할 수 없다면 어떤 추가 문맥이 있어야 판정할 수 있는가?

파일 수, diff 크기, 토큰 겹침은 merge 차단 근거가 아닙니다.

## Verdict lattice

```text
insufficient ── 전체 diff/checkout 필요
independent  ── proximity 외 상호작용 witness 없음
review       ── 의미적 상호작용은 있지만 호환 여부 미확정
conflict     ── 동시에 참일 수 없는 직접 witness 존재
```

`conflict`는 저장소 종류와 관계없이 논리적으로 설명할 수 있는 경우만 사용합니다.

- 같은 제거된 public signature를 서로 다르게 대체
- rename된 이름을 다른 PR이 새 코드에서 계속 사용
- 제거된 endpoint/event/field를 다른 PR이 새로 사용
- producer payload가 consumer가 요구하는 필드를 제공하지 않음
- 같은 설정에 상반된 기본값을 선언
- 도메인 detector가 증명한 resource lifecycle 모순

같은 파일, 같은 hunk, 같은 declaration은 관련성 신호지만 단독으로 `review`를 만들지 않습니다. 한 PR의 변경이 다른 PR의 실패 조건으로 이어지는 dependency, composition-risk 또는 contradiction witness가 있어야 경고로 승격합니다.

## Pipeline

### 1. Directional change model

각 patch를 `added`와 `removed` 방향을 유지한 구조로 변환합니다.

- file lifecycle: add, modify, rename, remove
- hunk base/new ranges
- declaration name과 signature
- added/removed identifiers
- API, DB, event, config, authorization surfaces
- rename pairs
- producer/consumer event shape

### 2. Detector composition

Detector는 두 normalized PR을 받고 0개 이상의 witness를 반환하는 작은 플러그인입니다.

```js
import { createAnalyzer, createWitness } from "assumption-radar";

const protobufDetector = {
  id: "protobuf-field-lifecycle",
  detect(prA, prB) {
    // prA.changeModel, prB.changeModel과 raw files를 검사한다.
    if (!removedFieldIsStillWritten(prA, prB)) return [];
    return [createWitness(
      "protobuf-field-reuse",
      "direct",
      "data",
      "삭제된 protobuf field number가 재사용됨",
      "한 PR이 제거한 field number를 다른 PR이 다른 의미로 다시 사용합니다.",
      ["payments.proto: field 7"],
    )];
  },
};

const analyzer = createAnalyzer({ additionalDetectors: [protobufDetector] });
const result = analyzer.analyze(openPullRequests);
```

Detector strength는 다음 세 가지입니다.

- `direct`: 논리적 모순을 증명하며 deterministic conflict를 생성
- `semantic`: 상호작용은 증명하지만 호환 여부는 AI/AST/테스트 문맥이 필요
- `proximity`: 후보 탐색에만 쓰며 사용자 경고를 만들지 않음

v0.3부터 strength와 별도로 causal role을 부여합니다.

- `contradiction`: 동시에 성립할 수 없는 직접 계약 증거 → `conflict`
- `dependency`: producer/consumer, schema/access처럼 방향성 의존성이 확인됨 → `review`
- `composition-risk`: 동일 동작의 경쟁 교체처럼 합성 위험이 확인됨 → `review`
- `relevance`: 같은 declaration/hunk라는 관련성만 확인됨 → 낮은 우선순위로 보존, 경고하지 않음
- `proximity`: 같은 파일 수준의 후보 탐색 신호

저장소별 semantic detector는 `createWitness`의 마지막 인자로 causal role을 명시할 수 있습니다. 명시하지 않은 custom semantic witness는 안전하게 `relevance`로 취급하며, direct witness는 항상 `contradiction`입니다.

기본 detector도 같은 인터페이스로 구성됩니다.

### 3. Semantic resolver

`review`만 semantic resolver에 전달합니다. 기본 resolver는 OpenAI Responses API를 사용해 다음 중 하나를 반환합니다.

- `conflict`: 숨은 전제가 실제로 양립 불가능함
- `compatible`: 변경 의도가 정렬되어 함께 적용 가능함
- `uncertain`: base 코드, 호출 그래프 또는 테스트가 더 필요함

AI는 deterministic conflict를 지울 수 없습니다. 동일 파일뿐인 pair에는 AI 비용을 사용하지 않습니다.

### 4. Coordination explainer

`git merge-tree`가 텍스트 충돌을 확인하면 silent semantic 판정 대신 해결 전략을 설명합니다.

Preflight는 raw PR head끼리 직접 병합하지 않습니다. 각 PR을 동일한 최신 target base에 적용한 가상 merge commit을 먼저 만들고 그 결과끼리 비교합니다. 이렇게 해야 서로 다른 시점의 base history가 pair conflict처럼 되살아나는 것을 막을 수 있습니다. 개별 PR이 현재 base와 충돌하면 pairwise 관계는 `insufficient / base-conflict`로 보류해 하나의 낡은 PR이 여러 경고를 만드는 것을 방지합니다.

- `resolution-risk`: 한쪽이 bug fix와 회귀 테스트를 추가하고 다른 쪽이 같은 동작을 크게 rewrite함. `preserve-regression-fix`를 권고
- `duplicate-implementation`: 같은 이슈·호출부를 서로 다른 helper로 해결하고 같은 테스트 표면을 변경함. `deduplicate`를 권고
- subtype 미확정: 텍스트 충돌 외 의미 증거가 부족하면 generic resolution으로 abstain

Subtype은 제목 하나나 파일 겹침만으로 확정하지 않습니다. competing replacement, regression test, shared issue, distinct helper, rewrite scope 같은 독립 증거를 조합하고 evidence ID로 반환합니다.

### 5. Policy

분석과 조직 정책을 분리합니다. 기본 CI 정책은 다음과 같습니다.

- `conflict`: exit code 2, merge gate 가능
- `review`: Check annotation, 담당자 확인
- `independent`: 표시하지 않음
- `insufficient`: checkout 기반 재분석 요청

## 범용 확장 방향

저장소별 차이는 점수 조정이 아니라 detector와 parser adapter로 표현합니다.

| 생태계 | 추가할 witness 예시 |
|---|---|
| GraphQL | 제거된 field를 새 query가 선택함 |
| Protobuf | field number 재사용, required lifecycle 충돌 |
| Kafka/AsyncAPI | producer/consumer schema 불일치 |
| SQL | expand-contract 순서 위반, rename 후 구이름 접근 |
| Terraform | resource address 이동과 동시 수정 |
| Kubernetes | selector/label 불일치, CRD version 제거 |
| Package API | public signature 분기와 call-site 불일치 |

언어 AST가 필요한 경우 detector 내부에서 Tree-sitter, compiler index, LSP 또는 repository checkout을 사용할 수 있습니다. 코어는 그 결과를 동일한 witness 구조로 받아 UI, AI resolver, CI policy에 전달합니다.

## 현재 한계

- GitHub patch가 생략된 대형·binary 파일은 `insufficient`가 됩니다.
- 기본 declaration parser는 언어 중립 휴리스틱이며 완전한 AST가 아닙니다.
- 같은 declaration을 수정했다는 사실만으로 호환성을 주장하지 않습니다. causal proof가 없으면 경고로 승격하지 않으며 repository context가 필요한 가설로 보존합니다.
- history 기반 예제 데이터처럼 모든 pair가 같은 declaration을 변경하는 경우 deterministic layer만으로 conflict/harmless를 억지로 분류하지 않습니다.
