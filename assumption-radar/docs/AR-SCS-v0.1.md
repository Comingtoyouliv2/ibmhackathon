# Assumption Radar Semantic Change Standard · AR-SCS v0.1

## 목적

AR-SCS는 언어 문법을 하나로 통일하지 않는다. 각 언어 adapter가 PR의 변경을 동일한 Semantic Change IR(SCIR)로 변환하고, core detector가 언어와 무관한 관계 규칙을 실행하도록 표준화한다.

```text
Git diff
  → language adapter
  → SCIR change set
  → language-independent rule
  → validator
  → verdict + evidence IDs
```

이 버전의 schema identifier는 `ar-scs-0.1`이다.

## SCIR 구성

### Entity

변경되거나 참조되는 의미 단위다.

- `module`, `type`, `callable`, `field`, `parameter`, `binding`
- `database-column`, `api-endpoint`, `event`, `config-key`, `file`, `symbol`

Entity identity는 가능하면 compiler, AST, LSP가 해석한 stable symbol ID를 사용한다. 불가능하면 adapter ID, 파일, scope, 이름을 결합한 provisional ID를 사용하고 evidence grade를 낮춘다.

### Operation

PR이 entity에 수행한 변경이다.

- `add`, `remove`, `rename`, `move`
- `change-signature`, `change-type`, `change-default`, `change-visibility`, `change-behavior`

### Dependency

변경된 코드가 다른 entity에 의존하는 방향을 표현한다.

- `calls`, `imports`, `references`, `reads`, `writes`
- `extends`, `implements`, `produces`, `consumes`, `serializes`, `configures`, `asserts`, `requires-binding`

`status: added`는 해당 dependency가 PR에서 새로 생겼다는 뜻이다. 단순 이동은 add/remove를 상쇄해 `added`로 내보내지 않아야 한다.

### Assumption

PR의 숨은 전제를 공통 용어로 표현한다.

- `requires`: 병합 결과에도 존재해야 하는 계약
- `provides`: PR이 새로 제공하는 계약
- `invalidates`: PR이 더 이상 유효하지 않게 만드는 계약
- `preserves`: PR이 유지한다고 주장하는 계약

Core conflict rule의 기본 형태는 다음과 같다.

```text
A.invalidates ∩ B.requires ≠ ∅
or
B.invalidates ∩ A.requires ≠ ∅
```

## Evidence grade

| Grade | 의미 | 예 |
|---|---|---|
| `proximity` | 관련 위치만 확인 | 같은 파일·hunk |
| `structural` | diff 구조로 관계 추론 | 반복 identifier 치환 |
| `resolved` | symbol identity 해석 | AST/LSP/compiler binding |
| `executable` | 실행으로 실패 증명 | compiler/test/integration failure |

모든 operation과 dependency는 최소 하나의 evidence ID를 참조해야 한다. 설명기는 입력에 포함된 evidence ID만 선택해야 하며 자유 인용으로 새로운 근거를 만들면 안 된다.

## Verdict policy

| Verdict | 표준 조건 |
|---|---|
| `coordination` | base-normalized merge-tree가 textual conflict를 증명 |
| `conflict` | 방향성 contradiction의 proof obligation 충족 |
| `review` | dependency는 있으나 identity 또는 실패 조건 미확정 |
| `independent` | contradiction 없이 relevance/proximity만 존재 |
| `insufficient` | patch, symbol, build 또는 preflight 정보 부족 |

`structural` evidence는 원칙적으로 `review`다. 다만 rule이 제한된 문법, net-new dependency, 대체 계약 부재, hard-negative controls를 모두 증명하는 경우 policy가 deterministic conflict로 승격할 수 있다. 승격 정책은 witness metadata에 기록한다.

## Adapter contract

각 adapter는 다음 interface를 구현한다.

```js
{
  id: "java-v0.1",
  supports({ filename, language }): boolean,
  extract({ changeSetId, pr, file, fileModel, language }): {
    entities: [],
    operations: [],
    dependencies: [],
    assumptions: [],
    evidence: []
  }
}
```

요구사항:

1. ID는 같은 입력에서 결정적이어야 한다.
2. 주석·문자열만의 token을 symbol dependency로 만들지 않는다.
3. 이동은 net-new add로 내보내지 않는다.
4. 불확실한 symbol identity는 metadata와 evidence grade에 표시한다.
5. adapter는 verdict를 결정하지 않는다. core rule과 policy가 결정한다.
6. schema conformance와 positive/control fixture를 모두 통과해야 registry에 등록할 수 있다.

Adapter는 `deterministicEligible` metadata로 해당 structural rule이 실제 positive/hard-negative benchmark를 통과했는지 알릴 수 있다. `false`이면 core는 dependency를 찾더라도 `review` 이상으로 승격하지 않는다. 이 값은 언어 지원 선언이 아니라 rule별 검증 상태다.

## Conformance

Adapter 승격 조건:

- schema validation 통과
- 동일 입력에서 stable ID 재현
- 지원 operation/dependency별 positive fixture 보유
- move, replacement binding, fully-qualified use 등 control fixture 보유
- repo 단위 holdout에서 결과 보고
- 언어별·archetype별 detector activation과 hard-negative FP 보고

전체 평균만으로 범용성을 주장하지 않는다. 최소 보고 단위는 `language × archetype × distance × evidence grade`다.

## v0.1 구현 범위

- Generic diff adapter: declaration, call, reference, inferred/explicit rename을 SCIR로 투영
- Java adapter: explicit class import와 simple-name binding requirement를 SCIR로 투영
- Python adapter: `import`와 `from ... import ...` binding lifecycle을 SCIR로 투영
- TypeScript adapter: default, namespace, named, aliased import binding lifecycle을 SCIR로 투영
- 기존 rule 중 `rename-vs-reference`, `import-vs-use`를 SCIR 기반으로 실행
- 기존 Java frozen benchmark 결과를 regression anchor로 유지

Python과 TypeScript adapter는 현재 synthetic conformance fixture만 통과했다. 실제 repository precision/recall은 언어별 positive와 hard-negative가 수집되기 전까지 미측정이다. Go와 코드 외 계약 adapter는 다음 단계이며 core rule을 복제하지 않는다.
