# assumption-radar — 평가 실행 시스템 (실제 러너 포함)

semantic-conflict 평가 스위트 v0.1 의 두 테스트를 **끝까지 자동 실행**해 `submission/` 을 만드는 코드다.
설계 핵심: **결정적 분석으로 후보/근거를 좁히고, LLM 은 판정·랭킹만** 담당.

## 구성

| 파일 | 역할 | 종류 |
|---|---|---|
| `analyze-pairs.mjs` | Test1: 40쌍 → 케이스별 dossier(공유파일·교차심볼) | 결정적 |
| **`run-pair-judge.mjs`** | **Test1: 실제 LLM 호출 40회 → pred-NN.json** | **AI 러너** |
| `fix-json2.mjs` | AI 출력의 제어문자(탭/줄바꿈) 이스케이프 (형식 보정) | 결정적 |
| `sanitize-evidence.mjs` | verbatim 아닌 근거 제거(필수 라벨은 보존) | 결정적 |
| `assemble-pair.mjs` | → `submission/pair-qualification-predictions.jsonl` | 결정적 |
| `analyze-episodes.mjs` | Test2: 780쌍 → 모듈 필터 → 같은모듈 20쌍 후보 dossier | 결정적 |
| **`run-e2e-rank.mjs`** | **Test2: 실제 LLM 호출 2회 → episode-0X-ranked.json** | **AI 러너** |
| `assemble-e2e.mjs` | → `submission/radar-arena-predictions.jsonl` | 결정적 |
| `score.mjs` | 채점기(gold 있으면 정확도, 없으면 분포) | 결정적 |

## 설치

스크립트는 **평가 스위트 루트** 기준 상대경로를 쓴다. `work/` 폴더로 두고 **루트에서** 실행한다.

```bash
# <스위트 루트>/ 에 package.json 을, <스위트 루트>/work/ 에 *.mjs 를 배치
npm install                       # @anthropic-ai/sdk
export ANTHROPIC_API_KEY=sk-ant-...   # 필수 (없으면 러너가 인증 실패)
mkdir -p work/pair work/e2e submission
```

## 실행

```bash
# ── Test 1 · Pair Judgment (40건) ──
node work/analyze-pairs.mjs        # dossier (참고용; 러너는 원본 CASE_JSON 사용)
node work/run-pair-judge.mjs       # ★ 실제 LLM 호출 40회
#   --limit 2   먼저 2건만 스모크 테스트
#   --only 07   특정 케이스만 재실행
node work/fix-json2.mjs            # (필요 시) 제어문자 보정
node work/sanitize-evidence.mjs    # verbatim 아닌 근거 정리
node work/assemble-pair.mjs        # → submission/pair-qualification-predictions.jsonl
node semantic-conflict-pair-judgment-v0.1/validate-submission.mjs \
  semantic-conflict-pair-judgment-v0.1/inputs.jsonl \
  submission/pair-qualification-predictions.jsonl \
  submission/pair-qualification-run.json

# ── Test 2 · End-to-End Radar (에피소드 2개) ──
node work/analyze-episodes.mjs     # 후보 20쌍/에피소드 → dossier + -top.json
node work/run-e2e-rank.mjs         # ★ 실제 LLM 호출 2회
node work/assemble-e2e.mjs         # → submission/radar-arena-predictions.jsonl
node semantic-conflict-end-to-end-v0.1/validate-submission.mjs \
  semantic-conflict-end-to-end-v0.1/episodes \
  submission/radar-arena-predictions.jsonl \
  submission/radar-arena-run.json
```

러너는 실측 latency/token 을 `work/pair-run-meta.json` · `work/e2e-run-meta.json` 에 남긴다 → run.json 작성 시 그대로 사용(추정 금지).

## 규칙 준수 (러너 구현 근거)

- **Test1**: `SYSTEM_PROMPT.txt` 를 system 으로 **변경 없이** 사용. `USER_PROMPT_TEMPLATE.txt` 의 `{{CASE_JSON}}` **만** 해당 입력 줄(전체 레코드)로 치환. 입력 한 줄당 **AI 호출 1회**, 케이스 간 정보 유입 없음.
- **Test2**: `TASK_PROMPT.txt` 를 system 으로 변경 없이 사용. 에피소드 원본이 3.3MB/**8.3MB**(후자는 1M 컨텍스트 초과)라 전량 주입 불가 → TASK_PROMPT 의 *"Development freedom: deterministic analysis / heuristics / LLM calls 조합 가능"* 조항에 따라 결정적 전처리로 후보를 좁힌 뒤 랭킹시킨다.
- **temperature**: **Opus 4.8 은 `temperature`/`top_p`/`top_k` 를 거부한다(전송 시 400).** 규칙의 *"temperature 는 0 또는 사용 모델이 지원하는 가장 결정적인 설정"* 에 따라 **샘플링 파라미터를 전송하지 않고** `output_config.effort` 를 고정한다. 이것이 이 모델에서 가능한 가장 결정적인 설정이다.
- **token/cost**: 응답 `usage` 에서 실측해 기록. 추정하지 않는다.

## 모델 교체 지점 (팀 비교용)

AI 호출은 **딱 두 곳**이다 — `run-pair-judge.mjs` 의 `client.messages.create(...)` 와 `run-e2e-rank.mjs` 의 동일 호출.
이 두 곳의 클라이언트/모델만 바꾸면 **동일 하네스에서 모델 비교**가 된다(GPT 등). 프롬프트·입력·조립·검증은 전부 공유되므로 비교가 공정하다.

## 구현 함정 (실측으로 확인됨)

- **`String.replace(pattern, 문자열)` 금지** — 치환값 안의 `$&`, `` $` ``, `$'`, `$$` 를 특수 패턴으로 해석해 프롬프트를 오염시킨다. 실제로 **케이스 03·29·38** 의 패치에 이 문자열이 있어 재현됨. 반드시 **함수 replacer** (`replace(p, () => value)`) 를 쓸 것.
- **AI 출력의 제어문자** — 패치에서 탭/줄바꿈을 그대로 인용하면 JSON 문자열 안에 생 제어문자가 들어가 `JSON.parse` 가 깨진다. 러너에 복구 로직 내장(값 내용 보존 → verbatim 매칭 영향 없음).
- **비용/규모(실측 문자수 기준 대략치)** — Test1 입력 합계 ≈ **2.9M 토큰**, 최대 단일 프롬프트 **2.77MB ≈ 725k 토큰**(케이스 24, 1M 컨텍스트 이내). 입력 비용 대략 **$15** 선. `--limit` 로 먼저 스모크 테스트할 것.

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
- 측정 못 하는 값은 추정 말고 `null`.