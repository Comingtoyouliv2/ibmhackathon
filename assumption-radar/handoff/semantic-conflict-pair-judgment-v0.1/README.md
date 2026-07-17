# Semantic Conflict Pair Judgment Test v0.1

이 패키지는 두 탐지기를 동일한 입력과 동일한 AI 프롬프트로 비교하기 위한 블라인드 qualification 세트다. 정답과 기존 시스템의 예측은 포함하지 않는다.

## 포함 파일

- `inputs.jsonl`: 평가할 PR pair 40건
- `SYSTEM_PROMPT.txt`: 모든 AI 호출에 동일하게 사용할 system prompt
- `USER_PROMPT_TEMPLATE.txt`: 각 JSONL 레코드를 넣을 user prompt
- `PROMPT_SHA256.txt`: 두 프롬프트를 결합해 계산한 고정 해시
- `prediction.schema.json`: AI 출력 JSON 규격
- `run.schema.json`: 실행 메타데이터 규격
- `validate-submission.mjs`: 제출 파일의 형식과 evidence quote를 검증하는 프로그램

## 고정 실행 조건

1. 입력 한 줄당 AI 호출 하나를 실행한다.
2. 모든 호출에 `SYSTEM_PROMPT.txt`를 변경 없이 사용한다.
3. `USER_PROMPT_TEMPLATE.txt`의 `{{CASE_JSON}}`만 해당 입력 줄로 치환한다.
4. temperature는 `0` 또는 모델이 지원하는 가장 결정적인 설정을 사용한다.
5. AI에는 `inputs.jsonl`의 해당 레코드만 제공한다.
6. 웹 검색, repository checkout, fixing commit, gold, 기존 prediction은 사용하지 않는다.
7. AI 응답의 JSON 객체를 입력 순서대로 `pair-qualification-predictions.jsonl`에 한 줄씩 기록한다.
8. 실제 latency/token/cost는 실행 wrapper가 선택적으로 prediction에 추가하고, 전체 합계는 `pair-qualification-run.json`에 기록한다. AI에게 수치를 추정시키지 않는다.
9. `pair-qualification-run.json.promptSha256`에는 `PROMPT_SHA256.txt`의 값을 그대로 기록한다.

내부 호출 코드와 모델 선택은 자유지만 프롬프트, 입력 정보, 출력 계약은 변경하지 않는다.

## 실행 예시

```bash
your-runner \
  --input inputs.jsonl \
  --system-prompt SYSTEM_PROMPT.txt \
  --user-prompt USER_PROMPT_TEMPLATE.txt \
  --output pair-qualification-predictions.jsonl \
  --run-output pair-qualification-run.json
```

## 제출 파일

```text
pair-qualification-predictions.jsonl
pair-qualification-run.json
```

형식을 검사한다.

```bash
node validate-submission.mjs inputs.jsonl pair-qualification-predictions.jsonl pair-qualification-run.json
```

성공하면 다음과 같이 출력된다.

```text
Submission valid: 40 predictions, 40 unique input cases.
```

이 세트는 pair 판단 qualification이다. 여러 open PR 중 후보를 직접 찾는 최종 end-to-end Radar Arena 점수는 별도의 multi-PR episode에서 측정한다.
