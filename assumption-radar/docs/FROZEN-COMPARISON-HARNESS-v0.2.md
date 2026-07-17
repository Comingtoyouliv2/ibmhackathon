# Frozen Comparison Harness v0.2

## 목적

우리 `assumption-radar v0.9`와 팀원 1의 `GPT-5.4 Contract Radar`를 동일한 공개 입력과 동일한 출력 계약으로 실행한다. 시스템 내부 구현과 프롬프트는 자유지만, 시스템은 gold에 접근할 수 없다.

이 하네스는 평가 실행 인프라다. 현재 v0.1 시험지는 smoke/regression 확인에만 사용하고, 최종 승자 선정에는 아직 제작하지 않은 blind v0.2 holdout을 사용한다.

## 시스템 어댑터

- `current`: `src/analyzer.mjs`의 SCIR·결정적 휴리스틱을 실행한다.
- `team1`: pair마다 격리된 Codex 호출 한 번, radar episode마다 격리된 Codex ranking 호출 한 번을 실행한다.
- 두 실행기 모두 public suite path만 받는다. gold path를 받는 옵션은 없다.
- gold는 모든 시스템 실행이 끝난 뒤 `run-comparison-v0.2.mjs`가 별도 evaluator에만 전달한다.

## Suite 계약

Pair suite:

```text
pair-suite/
  inputs.jsonl
  SYSTEM_PROMPT.txt
  USER_PROMPT_TEMPLATE.txt
  PROMPT_SHA256.txt
  prediction.schema.json
```

Radar suite:

```text
radar-suite/
  TASK_PROMPT.txt
  TASK_PROMPT_SHA256.txt
  prediction.schema.json
  episodes/
    episode-01.json
    episode-02.json
```

기존 v0.1과 스키마 호환성을 유지한다. 새 blind set은 원본 저장소·언어·사례가 기존 개발 셋과 겹치지 않아야 한다.

## 먼저 dry-run

```bash
npm run compare:v0.2 -- \
  --pair-suite handoff/semantic-conflict-pair-judgment-v0.1 \
  --radar-suite handoff/semantic-conflict-end-to-end-v0.1 \
  --output /tmp/radar-comparison-dry-run \
  --dry-run
```

`run-plan.json`에는 입력과 실행 코드의 SHA-256이 기록된다. 이 파일을 보존하면 실행 후 코드를 바꿨는지 확인할 수 있다.

## 실제 blind 실행

첫 단계에서는 gold를 넘기지 않는다.

```bash
npm run compare:v0.2 -- \
  --pair-suite /path/to/blind-v0.2/pair \
  --radar-suite /path/to/blind-v0.2/radar \
  --output /path/to/submissions/blind-v0.2 \
  --systems current,team1 \
  --team1-model gpt-5.4 \
  --team1-concurrency 4
```

두 시스템의 prediction이 모두 만들어진 후에만 score-only를 실행한다.

```bash
npm run compare:v0.2 -- \
  --pair-suite /path/to/blind-v0.2/pair \
  --radar-suite /path/to/blind-v0.2/radar \
  --output /path/to/submissions/blind-v0.2 \
  --systems current,team1 \
  --pair-gold /private/path/pair-gold.jsonl \
  --radar-gold /private/path/radar-gold.jsonl \
  --score-only
```

결과:

```text
output/
  run-plan.json
  comparison.json
  comparison.md
  current/
    pair/ predictions.jsonl, run.json
    radar/ predictions.jsonl, run.json
    pair-score/
    radar-score/
  team1/
    pair/ predictions.jsonl, run.json
    radar/ predictions.jsonl, run.json
    pair-score/
    radar-score/
```

## 최종 holdout 최소 조건

- 기존 40쌍과 저장소 단위로 분리한다.
- Java 외 Python·TypeScript 슬라이스를 둔다.
- 같은 module의 무해한 후보를 충분히 포함한다.
- cross-module 양성을 포함한다.
- 자연 OSS 분포와 균형 recall 세트를 별도로 집계한다.
- executable gold를 최우선으로 하고, contract-backed 사례는 독립 2인 검수한다.
- 시스템 동결 뒤 한 번만 실행한다.

현재 v0.1 데이터로 얻는 결과는 하네스 회귀 확인용이며 새로운 일반화 증거가 아니다.
