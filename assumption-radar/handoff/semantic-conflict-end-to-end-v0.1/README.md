# Semantic Conflict End-to-End Test v0.1

이 패키지는 여러 PR 중 semantic conflict pair를 직접 찾아 순위를 매기는 전체 Radar 성능을 비교한다. 정답, 원본 case ID, 기존 시스템 prediction은 포함하지 않는다.

## 시험 구성

- episode 2개
- episode당 PR 40개
- episode당 가능한 pair 780개
- 시스템은 episode마다 가장 위험한 pair 20개를 순서대로 제출
- 고정 과업 프롬프트 해시는 `TASK_PROMPT_SHA256.txt`에 기록

역사적으로 검증된 변경들을 익명화된 monorepo module에 재배치했다. 서로 다른 module은 구조적으로 격리되어 있다. 같은 module을 수정하는 두 PR도 실제 conflict일 수도 있고 hard negative일 수도 있으므로, 파일 경로가 겹친다는 이유만으로 conflict라고 판단하면 안 된다.

## 팀 공통 지시

1. 최상위 AI 또는 coding agent에 `TASK_PROMPT.txt`를 변경 없이 제공한다.
2. 입력은 `episodes/episode-01.json`, `episodes/episode-02.json`만 사용한다.
3. 외부 검색, repository checkout, gold, 기존 prediction은 사용하지 않는다.
4. 내부 구현은 자유다. 정적 분석, AST, graph, LLM, 여러 agent, heuristic을 원하는 방식으로 조합할 수 있다.
5. 각 episode의 가능한 모든 PR pair를 고려한다.
6. 가장 semantic conflict 가능성이 높은 20쌍을 순위대로 `radar-arena-predictions.jsonl`에 기록한다.
7. 실제 시간·토큰·비용은 `radar-arena-run.json`에 기록한다.
8. 제출 전 validator를 통과시킨다.

## 제출 형식

```text
radar-arena-predictions.jsonl
radar-arena-run.json
```

검증 명령:

```bash
node validate-submission.mjs episodes radar-arena-predictions.jsonl radar-arena-run.json
```

성공 출력:

```text
Submission valid: 2 episodes, 40 ranked pairs.
```

최종 비교 지표는 Recall@5/10/20, Precision@5/10/20, MAP@20, pair reduction, 실행 시간과 비용이다.

이 v0.1은 후보 검색과 pair 판단을 한꺼번에 측정하는 controlled end-to-end 시험이다. 실제 한 OSS 저장소의 자연 발생 open-PR 분포와 여러 언어에 대한 최종 일반화 주장은 별도의 prospective holdout에서 확인해야 한다.
