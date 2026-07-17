# Evaluation Tools

이 폴더에는 benchmark 데이터가 아니라 **평가 프로그램과 기계 판독 규격**만 둡니다.

| 파일 | 역할 |
|---|---|
| `evaluate.mjs` | JSONL prediction을 읽어 성능 지표를 계산하는 CLI |
| `evaluate-seed.mjs` | 분리된 gold/prediction JSONL을 결합해 실제 PR seed의 filtering·관계·coordination 설명을 평가 |
| `rubric.json` | metric과 초기 maturity gate의 기계 판독 정의 |

사람이 읽는 평가 설계는 [`../docs/EVALUATION_RUBRIC.md`](../docs/EVALUATION_RUBRIC.md)에 있습니다.

평가기 자체의 smoke fixture는 [`../test/fixtures/evaluator-smoke.jsonl`](../test/fixtures/evaluator-smoke.jsonl)에 있습니다. 이 fixture의 출력은 제품 성능이 아닙니다.

현재 실제 PR seed baseline은 `npm run eval:seed`로 실행합니다. Gold 파일에는 prediction을 넣지 않으며, baseline별 prediction과 결과를 별도 디렉터리에 보존합니다.
