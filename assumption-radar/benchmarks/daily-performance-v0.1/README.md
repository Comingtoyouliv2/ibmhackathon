# Daily performance benchmark v0.1

초기 고정 문제집은 새로 만들지 않고 검증 완료된 `semantic-clean-v0.1/frozen-v0.1`을 사용한다.

- 40 fixed cases
- 20 conflict / 20 harmless
- exact frozen PR patches and base/head SHAs
- gold와 inference input 분리
- mechanical Git conflict는 silent semantic benchmark에서 제외

## 아침 고정 문제집 실행

```bash
npm run perf:daily
```

결과는 `.cache/performance-runs/semantic-clean-v0.1/<timestamp>/`에 저장된다.

- `predictions.jsonl`: 이번 verdict
- `metrics.json`: precision/recall/operations
- `comparison.json`: 직전 run 대비 improved/regressed/changed
- `report.md`: 사람이 읽는 요약

항상 같은 40개 case를 실행하므로 직전 run과 case ID 단위로 비교할 수 있다.

### Full AI track

최종 애플리케이션 품질은 deterministic track만으로 판단하지 않는다. 동일한 40개 문제에서 bounded Codex second-look까지 실행한다.

```bash
CODEX_MODEL=gpt-5.6-sol \
CODEX_BIN=/path/to/new/codex \
npm run perf:daily:ai
```

기본값은 AI 대상 case를 각각 3회 실행한다. 세 verdict가 모두 같을 때만 conflict 또는 independent를 유지하고, 하나라도 다르면 `review / unstable-ai-consensus`로 보낸다. 출력에는 AI candidate 수, 실제 model call 수, stability rate와 흔들린 case가 포함된다.

`perf:daily`는 빠른 deterministic 코드 회귀용이고, `perf:daily:ai`가 최종 애플리케이션 성능용이다.

## 저녁 live snapshot 실행

```bash
CODEX_MODEL=gpt-5.6-sol \
CODEX_BIN=/path/to/new/codex \
npm run snapshot:live -- apache/zeppelin --limit 62 --ai --ai-provider codex
```

결과는 `.cache/live-snapshots/<owner__repo>/<timestamp>/`에 저장된다.

- `snapshot.json`: PR head/base SHA와 현재 경고 전체
- `diff.json`: 직전 snapshot 대비 new/changed/cleared/out-of-scope
- `report.md`: 사람이 읽는 변화 요약

PR 번호가 같아도 head SHA가 바뀌면 `changed`로 기록한다. 이전 경고의 PR이 현재 목록에도 있는데 경고가 사라지면 `cleared`, PR이 닫히거나 limit 밖으로 빠지면 `out-of-scope`로 분리한다.

## 개선 하네스

```bash
npm run improve:harness
```

가장 최근 frozen run과 저장소별 live snapshot diff를 읽어 다음 큐를 만든다.

- `code-actions.jsonl`: 검증된 deterministic FN/FP의 코드 수정 작업 패킷
- `prompt-actions.jsonl`: 반복 실행에서도 안정적으로 틀린 AI 판정의 prompt/context 수정 패킷
- `verification-actions.jsonl`: gold가 없는 새 live 경고의 Base/A/B/A+B 검증 패킷
- `human-questions.jsonl`: AI flip, Git coordination resolution, 사라진 confirmed 경고처럼 정책 판단이 필요한 질문

## 3단계: 개선 실행

사람 질문을 터미널에서 직접 답하거나, 생성된 answer template을 편집해 다시 입력할 수 있다.

```bash
npm run improve:answer -- --interactive
npm run improve:answer -- --answers /path/to/answers.jsonl
```

코드·프롬프트 작업은 현재 작업공간에서 바로 수정하지 않는다. 별도 임시 복사본에서 `gpt-5.6-sol` 개선 agent가 일반화된 수정과 counterexample test를 만들고, 전체 테스트와 frozen deterministic/AI benchmark를 통과시킨다. 회귀가 하나라도 생기거나 AI 불안정 case가 늘면 후보를 거절한다. 통과한 후보를 실제 source에 반영하려면 `--apply`를 명시한다.

```bash
CODEX_MODEL=gpt-5.6-sol CODEX_BIN=/path/to/codex npm run improve:execute
CODEX_MODEL=gpt-5.6-sol CODEX_BIN=/path/to/codex npm run improve:execute -- --apply
```

이미 gate 산출물에 저장된 후보를 agent 재호출 없이 full AI gate에서 재검증하려면 `--candidate-run .cache/improvement-executions/<run>`을 사용한다.
적용에 성공한 deterministic/AI 결과는 다음 일별 비교의 공식 accepted baseline으로 자동 게시된다.

live verification action은 저장된 immutable PR input을 사용하여 Docker에서 Base/A/B/A+B를 실행한다. Base가 실패하면 `baseline-failure`, A 또는 B가 단독 실패하면 `single-pr-regression`으로 semantic conflict 평가에서 제외하고 A+B를 실행하지 않는다. Base/A/B가 모두 통과한 뒤 A+B에서만 같은 failure signature가 반복 재현되어야 conflict로 확정된다.

live snapshot은 경고 pair뿐 아니라 `independent`로 판정된 pair도 실행 정책에 포함한다. 첫 실행은 실행시간을 지어내지 않고 거리별(same-file/contract, same-module, weak relation, random no-overlap) 4쌍을 pilot으로 측정한다. 이후 clean pair가 200쌍 이하이고 측정한 예상 실행시간이 2시간 이내이면 모든 clean pair를 `exhaustive`로 실행한다. 둘 중 하나라도 초과하면 기본 20쌍을 위험 70%·불확실성 20%·무작위 감사 10%로 고르는 `budgeted` 모드를 사용한다. 새 control 또는 SHA가 바뀐 control만 재실행하며, A+B에서만 반복 실패하면 `false-negative`로 `error-ledger.jsonl`에 기록된다.

실행 후 repository별 Base·단독 PR·A+B 중앙 실행시간을 `.cache/live-execution-profiles`에 저장하고 다음 snapshot의 정책 결정에 사용한다. Base와 단독 PR 결과는 repository·commit SHA·실행 profile 기준으로 한 실행 안에서 캐시한다. `--verification-mode auto|pilot|exhaustive|budgeted`, `--verification-pair-limit`, `--verification-budget-minutes`, `--pilot-controls`, `--budgeted-controls`로 정책을 조정할 수 있고, 기존 `--exploration-controls`는 명시적인 표본 수 override로 유지한다.

```bash
npm run improve:verify-live
```

## 4단계: 재검증과 문제집 승격

실행으로 확인한 live conflict와 compatible은 사람의 판정을 거친 뒤에만 새 immutable benchmark version으로 승격한다. conflict는 A+B 실패가 두 PR의 상호작용에서 발생했다는 인과 확인이 필요하고, compatible은 제한된 테스트 범위의 통과만으로 harmless gold를 단정하지 않도록 사람의 `harmless` 판정을 요구한다. 기존 `frozen-v0.1`은 절대 수정하지 않는다. 새 문제집 생성 직후 deterministic과 full AI baseline을 모두 실행한다.

```bash
CODEX_MODEL=gpt-5.6-sol CODEX_BIN=/path/to/codex npm run improve:promote
```

conflict 또는 compatible 승격 질문이 생기면 cycle은 `awaiting-human`으로 멈춘다. verification run의 `promotion-questions.jsonl`을 직접 묻고 답변을 저장한 뒤 승격을 재실행한다.

```bash
npm run improve:answer -- --questions .cache/live-verification-runs/<run>/promotion-questions.jsonl --interactive --output /tmp/promotion-decisions.jsonl
npm run improve:promote -- --human-decisions /tmp/promotion-decisions.jsonl
```

전체 루프는 한 명령으로 실행할 수 있다. 질문이 남으면 `awaiting-human`, 후보가 회귀 gate에서 탈락하면 `needs-attention`, 모든 gate가 통과하면 `complete` 상태를 남긴다.

```bash
CODEX_MODEL=gpt-5.6-sol CODEX_BIN=/path/to/codex npm run improve:cycle -- --interactive --apply
```

CI나 smoke 검증에서는 `--skip-ai`, live 실행 검증을 생략할 때는 `--skip-verification`, 개선 agent를 실행하지 않을 때는 `--skip-agent`를 사용할 수 있다.
