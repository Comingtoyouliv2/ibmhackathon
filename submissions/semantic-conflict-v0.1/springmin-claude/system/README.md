# assumption-radar — 평가 실행 시스템 (재현용 코드)

이 폴더는 semantic-conflict 평가 스위트 v0.1의 두 테스트를 실행해 `submission/`을 만든 **실제 코드**다.
설계 핵심은 **결정적 분석으로 후보를 좁히고, AI(LLM)는 판정/랭킹에만** 쓰는 것.

## 구성

| 파일 | 역할 | 단계 |
|---|---|---|
| `analyze-pairs.mjs` | Test1: 40쌍 → 케이스별 dossier(공유파일·교차심볼) | 결정적 |
| `assemble-pair.mjs` | Test1: pred-NN.json → `submission/pair-qualification-predictions.jsonl` | 결정적 |
| `fix-json2.mjs` | Test1: AI 출력의 제어문자(탭/줄바꿈) 이스케이프 (형식 보정) | 결정적 |
| `sanitize-evidence.mjs` | Test1: verbatim 아닌 근거 제거(필수 라벨은 보존) | 결정적 |
| `analyze-episodes.mjs` | Test2: 780쌍 → 모듈 필터 → 같은모듈 20쌍 후보 dossier | 결정적 |
| `assemble-e2e.mjs` | Test2: 랭킹 → `submission/radar-arena-predictions.jsonl` | 결정적 |
| `score.mjs` | 채점기(gold 있으면 정확도, 없으면 분포) | 결정적 |

**AI 판정/랭킹 단계는 스크립트가 아니라 LLM 호출**이다(아래 참고). 여기 스크립트는 그 앞뒤의 결정적 부분.

## 실행 방법

이 스크립트들은 **평가 스위트 루트**(inputs.jsonl / episodes / SYSTEM_PROMPT 가 보이는 곳) 기준 상대경로를 쓴다.
→ 스위트 루트에 `work/` 폴더로 두고, 루트에서 실행한다.

```bash
# 스위트 루트 기준
mkdir -p work/pair work/e2e submission

# ── Test 1 · Pair Judgment ──
node work/analyze-pairs.mjs           # 케이스별 dossier 40개 → work/pair/case-NN.md
#   ▶ AI 단계: 각 case-NN.md 를 고정 SYSTEM_PROMPT.txt 로 LLM에 판정시켜
#     work/pair/pred-NN.json (스키마: schemaVersion/id/prediction/confidence/
#     assumptionA/assumptionB/failureMechanism/explanation/evidence) 로 저장.
#     (우리는 케이스당 Claude Opus 4.8 격리 호출 1회 사용 — 모델은 교체 가능)
node work/fix-json2.mjs               # (필요 시) 제어문자 보정
node work/sanitize-evidence.mjs       # verbatim 아닌 근거 정리
node work/assemble-pair.mjs           # → submission/pair-qualification-predictions.jsonl
node semantic-conflict-pair-judgment-v0.1/validate-submission.mjs \
  semantic-conflict-pair-judgment-v0.1/inputs.jsonl \
  submission/pair-qualification-predictions.jsonl \
  submission/pair-qualification-run.json

# ── Test 2 · End-to-End Radar ──
node work/analyze-episodes.mjs        # 후보 dossier → work/e2e/episode-0X-candidates.md (+ -top.json)
#   ▶ AI 단계: 각 candidates.md 를 고정 TASK_PROMPT.txt 로 LLM에 랭킹시켜
#     work/e2e/episode-0X-ranked.json ([{prA,prB,decision,confidence,explanation}] x20) 로 저장.
node work/assemble-e2e.mjs            # → submission/radar-arena-predictions.jsonl
node semantic-conflict-end-to-end-v0.1/validate-submission.mjs \
  semantic-conflict-end-to-end-v0.1/episodes \
  submission/radar-arena-predictions.jsonl \
  submission/radar-arena-run.json
```

`run.json` 2개는 이번 실행값이 들어 있으니, 재실행 시 startedAt/finishedAt/model 등을 자기 실행에 맞게 갱신하면 된다.

## AI 단계 상세 (모델 교체 지점)

- **Test 1**: 입력 = `SYSTEM_PROMPT.txt`(고정) + 한 케이스 dossier. 출력 = 예측 JSON 1건. **케이스당 독립 호출**(다른 케이스 정보 유입 금지).
- **Test 2**: 입력 = `TASK_PROMPT.txt`(고정) + 에피소드 후보 dossier. 출력 = 20쌍 랭킹 JSON.
- 우리 실행은 전 판정 **claude-opus-4-8**. 이 두 지점만 다른 모델(GPT 등)로 바꾸면 **동일 하네스에서 모델 비교**가 된다.

## 채점 (gold 받으면)

```bash
node work/score.mjs work/gold-pair.jsonl work/gold-e2e.jsonl
# gold-pair.jsonl : {"id":"...","label":"conflict|review|independent|insufficient|coordination"}
# gold-e2e.jsonl  : {"episodeId":"...","conflictPairs":[["PR-001","PR-002"], ...]}
# 출력: accuracy · 클래스별 P/R/F1 · conflict vs not-conflict · P@5/10/20 · Recall@20
```

## 규칙 준수 (재현 시 유지)

- 고정 프롬프트/입력 수정 금지, gold·fixing commit·웹검색·repo checkout 금지.
- 결과 보고 프롬프트/규칙 튜닝 후 재제출(test-time tuning) 금지.
- 측정 못 하는 값(token/cost 등)은 추정 말고 `null`.