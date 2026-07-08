# Step 1 설계 — Intent Card 추출

> **상태:** 설계 확정 · 구현 대기  
> **선행:** Step 0 (`data/passed.jsonl`)  
> **후행:** Step 2 버킷팅 & 프루닝 (`data/cards.jsonl` 소비)  
> **원칙:** PR당 LLM 1회 · 기계가 조인하는 필드만 구조화 · 판단 재료는 자연어 문장

---

## 1. 목표

Step 0에서 통과한 로직 변경 PR마다 **Intent Card** 한 장을 추출한다. 카드는 "이 PR이 무엇을 바꾸고, 어떤 공유 자원을 건드리며, 어떤 가정을 전제로 하는가"를 구조화해 Step 2(후보 쌍 생성)와 Step 3(관계 판정)의 입력이 된다.

Step 1은 **의미 이해가 필요한 유일한 PR 단위 단계**다. 이후 단계는 카드 메타데이터와 문장 임베딩으로 조합 폭발을 막는다.

```
data/passed.jsonl (N PR)
  │ diff 수집 (GitHub API, logic 파일만)
  │ LLM 추출 (PR당 1회, 구조화 JSON)
  ▼
data/cards.jsonl (N장, 성공분)
data/step1.jsonl (전체 감사 추적)
data/diffs/{pr}.json (캐시)
```

---

## 2. I/O 계약

### 2.1 입력

| 파일 | 타입 | 설명 |
|---|---|---|
| `data/passed.jsonl` | `RawPr` | Step 0 `verdict=pass` 원본 PR. **주 입력.** |
| `data/step0.jsonl` | `Step0Result` | `signalStrength`, `logicChangeLines` 등 우선순위·리포트용. PR 번호로 조인. |
| `data/prs.jsonl` | `RawPr` | `passed.jsonl`에 없는 메타가 필요할 때 fallback (현재는 중복). |

`RawPr` / `Step0Result` 스키마는 `pipeline/src/types.ts`에 정의되어 있다.

**실행 전제**

- `GITHUB_TOKEN` — diff REST API 호출
- `OPENAI_API_KEY` 또는 `ANTHROPIC_API_KEY` — 추출 LLM (`.env`에 추가)
- `data/passed.jsonl` 존재 (`npm run step0` 완료)

### 2.2 출력

| 파일 | 타입 | 설명 |
|---|---|---|
| `data/cards.jsonl` | `IntentCard` | 추출 성공 카드. **Step 2 직접 입력.** |
| `data/step1.jsonl` | `Step1Record` | PR별 상태 전체 — `success` / `skipped` / `failed` + `reason`. 감사 추적. |
| `data/diffs/{pr}.json` | `CachedDiff` | PR별 diff 캐시. 재실행 시 API 호출 절약. |
| `data/step1-checkpoint.json` | `Step1Checkpoint` | 중단 재개용 진행 상태. |
| `data/step1-report.md` | — | 품질·비용·커버리지 요약 리포트. |

### 2.3 Step 2 소비 계약

Step 2는 `data/cards.jsonl`만 읽는다. 각 줄은 유효한 `IntentCard`여야 하며, 최소 필수 필드:

- `pr`, `summary`, `touched_resources`, `assumptions`, `confidence`
- `behavior_changes` — Step 3·시각화에서 사용; Step 2 버킷팅에는 보조
- `domains` — 약한 신호(④ 도메인∩파일 겹침)
- `embedding` — Step 2가 생성하거나 Step 1에서 선계산(설계 선택지, §8 참고)

Step 1은 **쌍(pair)을 생성하지 않는다.**

---

## 3. 파일 구조 (구현 예정)

```
pipeline/
├── docs/
│   └── step1-design.md          ← 본 문서
├── src/
│   ├── types.ts                 ← IntentCard, Step1Record 등 타입 추가
│   ├── classify.ts              ← logic 파일 필터 재사용 (변경 없음)
│   ├── diff.ts                  ← NEW: PR diff 수집·캐시·트렁케이션
│   ├── intent-card.ts           ← NEW: 스키마·Zod 검증·프롬프트·정규화 (단일 진실 공급원)
│   ├── extract.ts               ← NEW: LLM 호출·JSON 파싱·재시도
│   └── step1.ts                 ← NEW: 오케스트레이션·체크포인트·리포트
├── data/
│   ├── passed.jsonl             ← 입력 (Step 0)
│   ├── cards.jsonl              ← 출력
│   ├── step1.jsonl              ← 출력
│   ├── diffs/                   ← 캐시 디렉터리
│   ├── step1-checkpoint.json
│   └── step1-report.md
└── package.json                 ← `step1` 스크립트 추가
```

**설계 원칙:** 스키마 정의·프롬프트 템플릿·`touched_resources` 접두어 규칙은 **`intent-card.ts` 한 파일**에서만 관리한다. 추출기·검증기·리포트가 동일 계약을 공유해 형식 불일치를 차단한다.

---

## 4. Diff 수집

### 4.1 API 선택

Step 0 `fetch.ts`는 GraphQL로 PR 메타·파일 목록만 수집한다. **unified diff 본문은 Step 1에서 별도 수집**한다.

| 방식 | 엔드포인트 | 장점 | 단점 |
|---|---|---|---|
| **REST (권장)** | `GET /repos/{owner}/{repo}/pulls/{number}` → `diff_url` 또는 `Accept: application/vnd.github.diff` | 구현 단순, 토큰 1회/PR | 대형 PR diff 용량 |
| GraphQL | `pullRequest` + patch 없음 | — | unified diff 미제공 |

**권장 흐름**

1. `passed.jsonl`의 `RawPr.files`에서 `classifyFile(path) === 'logic'` 인 파일만 선별
2. REST `pulls/{number}/files`로 파일별 patch 조회 (페이지네이션 `per_page=100`)
3. logic 파일 patch만 합쳐 `CachedDiff` 저장

Step 0와 동일하게 **rate-limit 인식** (`fetch.ts`의 `maybeWaitForRate`, 지수 백오프 재시도) 패턴을 재사용한다.

### 4.2 CachedDiff 스키마

```typescript
interface CachedDiff {
  pr: number;
  fetchedAt: string;       // ISO 8601
  prUpdatedAt: string;     // RawPr.updatedAt — 무효화 키
  diffHash: string;        // sha256(logic patches + file list)
  logicFiles: Array<{
    path: string;
    patch: string;         // GitHub patch hunk (없으면 "binary" 또는 빈 문자열)
    additions: number;
    deletions: number;
  }>;
  truncated: boolean;      // §4.3 한도 초과로 잘림
  totalLogicLines: number;
}
```

### 4.3 트렁케이션·우선순위

대형 PR에서 토큰 폭발을 막는다.

| 한도 | 기본값 | 동작 |
|---|---|---|
| `MAX_DIFF_CHARS` | 24_000 | logic 파일을 `logicChangeLines` 내림차순으로 누적 patch 추가, 초과 시 `truncated=true` |
| `MAX_LOGIC_FILES` | 30 | 상위 N개 logic 파일만 포함 |
| `MAX_PATCH_PER_FILE` | 4_000 chars | 파일별 patch 상한 |

`RawPr.filesTruncated === true` 인 PR은 diff 수집 후에도 `confidence` 상한 0.6 권고(프롬프트 힌트).

### 4.4 캐시 무효화

다음 중 하나라도 바뀌면 재수집:

- `prUpdatedAt` 불일치
- logic 파일 목록 변경 (`diffHash` 불일치)
- 캐시 파일 없음

---

## 5. LLM 통합

### 5.1 호출 모델

| 용도 | 모델 (기본) | 비고 |
|---|---|---|
| Intent Card 추출 | `gpt-4.1-mini` 또는 `claude-sonnet-4` | 구조화 JSON, 비용·속도 균형 |
| 저신뢰 재추출 (선택) | 동일 또는 상위 모델 | `confidence < 0.5` 샘플만 |

환경 변수:

```bash
LLM_PROVIDER=openai          # openai | anthropic
LLM_MODEL=gpt-4.1-mini
LLM_MAX_TOKENS=4096
MAX_CARDS=Infinity           # 실험용 상한 (Step 0 MAX_PRS와 동일 패턴)
```

### 5.2 프롬프트 구조 (`intent-card.ts`)

**시스템 메시지** — 역할·출력 규칙·`touched_resources` 접두어 정의  
**사용자 메시지** — 아래 컨텍스트 블록:

```
[PR 메타]
number, title, body(4000자 이내), labels

[변경 파일 요약]
logic 파일 목록 + additions/deletions

[Diff]
logic patch (트렁케이션 시 명시)

[출력 스키마]
JSON only, IntentCard 스키마 예시
```

**추출 지침 (핵심)**

- `summary`: 한국어 1~2문장, 대시보드 툴팁용
- `behavior_changes`: 표면(surface) 단위 before/after. 함수·모듈·API 경계
- `touched_resources`: 반드시 접두어 사용 — `state:` `config:` `api:` `schema:` `event:` `file:`
- `assumptions`: 이 PR이 계속 참이라 가정하는 전제 (Step 3 상호 검증 재료)
- `domains`: 레포 위험 섹터 (`session-state` | `compatibility` | `security-boundary` | `message-delivery` | `gateway` | `other`)
- `confidence`: diff 잘림·맥락 부족·바이너리만 변경 시 0.5 이하

### 5.3 응답 처리

1. LLM 응답에서 JSON 추출 (markdown fence 제거)
2. `intent-card.ts`의 Zod 스키마로 검증
3. `touched_resources` 접두어·정규화 (소문자, 공백 제거, 중복 제거)
4. 검증 실패 시 **최대 2회 재시도** (동일 diff, 오류 메시지를 힌트로 추가)
5. 3회 실패 → `step1.jsonl`에 `failed` + `reason: llm_parse_error`

### 5.4 PR당 1회 원칙

- 한 PR에 대해 성공 카드가 있고 `diffHash`가 동일하면 **LLM 호출 스킵**
- PR 본문·diff가 갱신되면 재추출 (기존 카드는 동일 `pr` 키로 덮어쓰기)

---

## 6. Intent Card 스키마

### 6.1 IntentCard

```typescript
interface BehaviorChange {
  surface: string;   // e.g. "SessionCache.set", "POST /v1/sessions"
  before: string;    // 변경 전 동작 (한국어)
  after: string;     // 변경 후 동작 (한국어)
}

type ResourcePrefix = 'state' | 'config' | 'api' | 'schema' | 'event' | 'file';

type Domain =
  | 'session-state'
  | 'compatibility'
  | 'security-boundary'
  | 'message-delivery'
  | 'gateway'
  | 'other';

interface IntentCard {
  pr: number;
  title: string;                    // RawPr.title 복사 — 조인 편의
  summary: string;
  behavior_changes: BehaviorChange[];
  touched_resources: string[];      // "prefix:path" 형식, 최소 1개 권장
  assumptions: string[];            // 최소 1개 권장
  domains: Domain[];
  confidence: number;               // 0.0 ~ 1.0

  // --- Step 1 메타 (Step 2/3 전달) ---
  signalStrength: SignalStrength;   // step0.jsonl에서 조인
  diffHash: string;
  extractedAt: string;
  model: string;
  truncated: boolean;               // diff 잘림 여부
}
```

### 6.2 touched_resources 접두어 규칙

| 접두어 | 의미 | 예시 |
|---|---|---|
| `state:` | 런타임 공유 상태 | `state:session.warningDedupeCache` |
| `config:` | 설정 키·플래그·환경 변수 | `config:SESSION_CACHE_MAX` |
| `api:` | 공개 함수·엔드포인트 | `api:sendMessage()` |
| `schema:` | 데이터 구조·DB 스키마 | `schema:TranscriptEntry` |
| `event:` | 이벤트·메시지 타입 | `event:message.failed` |
| `file:` | 동일 경로·포맷 계약 | `file:src/session/cache.ts` |

정규화: `state:compaction.ownership` vs `state:compaction.Ownership` → 소문자 통일. Step 2 **정확 일치** 버킷의 기준 키.

### 6.3 예시 (openclaw #101643)

```json
{
  "pr": 101643,
  "title": "fix(session): cap warning dedupe cache size",
  "summary": "세션 유지보수 경고 dedupe 캐시가 무한히 커지는 걸 LRU 축출로 막는다",
  "behavior_changes": [
    {
      "surface": "SessionCache.set",
      "before": "엔트리를 무제한으로 저장",
      "after": "1000개 초과 시 가장 오래 안 쓴 엔트리부터 삭제"
    }
  ],
  "touched_resources": [
    "state:session.warningDedupeCache",
    "config:SESSION_CACHE_MAX"
  ],
  "assumptions": [
    "캐시 엔트리는 축출돼도 다시 만들 수 있다 (영구 데이터가 아니다)",
    "다른 코드가 '한 번 캐시된 키는 계속 존재한다'에 의존하지 않는다"
  ],
  "domains": ["session-state"],
  "confidence": 0.85,
  "signalStrength": "high",
  "diffHash": "a1b2c3...",
  "extractedAt": "2026-07-08T05:00:00.000Z",
  "model": "gpt-4.1-mini",
  "truncated": false
}
```

### 6.4 Step1Record (감사 추적)

```typescript
type Step1Status = 'success' | 'skipped' | 'failed';

interface Step1Record {
  pr: number;
  status: Step1Status;
  reason: string;           // e.g. "cached", "llm_parse_error", "no_logic_diff"
  confidence?: number;
  durationMs?: number;
  llmTokensIn?: number;
  llmTokensOut?: number;
  updatedAt: string;
}
```

---

## 7. 재개·캐싱

Step 0 `fetch.ts` 체크포인트 패턴을 그대로 따른다.

### 7.1 실행 흐름

```bash
npm run step1    # 중단(Ctrl-C) 후 재실행 시 이어받기
```

1. `data/step1-checkpoint.json` 로드 (없으면 fresh start)
2. `passed.jsonl` + `step0.jsonl` 로드, PR 번호 집합 구성
3. `cards.jsonl` 기존 성공 카드 인덱스 (`pr` → `diffHash`)
4. PR 목록을 **우선순위 큐**에 넣고 순회 (§9.2)
5. PR별: diff 캐시 확인 → 필요 시 API 수집 → 캐시 hit 시 LLM 스킵 → 아니면 추출
6. 매 PR 처리 후 checkpoint 갱신 (원자적 write: temp + rename)
7. 완료 시 `step1-report.md` 생성, checkpoint `done: true`

### 7.2 Step1Checkpoint

```typescript
interface Step1Checkpoint {
  processed: number[];      // 완료된 PR 번호
  done: boolean;
  startedAt: string;
  lastUpdatedAt: string;
}
```

### 7.3 멱등성

- `step1.jsonl`: append-only가 아닌 **PR 키 기준 upsert** (재실행 시 전체 재작성 허용)
- `cards.jsonl`: 성공 카드만, `pr` 기준 최신 1장
- diff 캐시: 내용 주소 기반 파일명 `data/diffs/{pr}.json`

---

## 8. 비용 통제

| 레버 | 메커니즘 |
|---|---|
| **입력 축소** | Step 0가 이미 ~82% 제외 (openclaw 실측). Step 1은 `passed`만 처리. |
| **실험 상한** | `MAX_CARDS=50` — 소규모 파일럿 (Step 0 `MAX_PRS`와 동일 UX) |
| **우선순위** | `signalStrength=high` → `unknown` → `low` 순. 예산 소진 시 중단·재개. |
| **Diff 트렁케이션** | §4.3 — 입력 토큰 상한 |
| **캐시** | diff + 성공 카드 재사용 — 재실행 비용 ≈ 0 |
| **모델 선택** | 추출은 mini/sonnet급. Opus는 Step 3(쌍 판정)에만 예약. |
| **배치 금지** | PR당 1회 고정. 배치로 여러 PR을 한 프롬프트에 넣지 않음 (품질·디버깅). |
| **비용 로깅** | `step1.jsonl`에 `llmTokensIn/Out` 누적 → 리포트에 총 토큰·추정 USD |

**추정 (openclaw pass ~2,310장 기준)**

- diff REST: ~2,310 요청 (캐시 후 0)
- LLM: ~2,310 호출 × ~3k input tokens ≈ 7M tokens — mini 기준 수 USD 대역 (리포트로 실측 보정)

---

## 9. 품질 검증

### 9.1 자동 검증

| 검사 | 시점 | 실패 처리 |
|---|---|---|
| Zod 스키마 | LLM 응답 직후 | 재시도 → `failed` |
| `touched_resources` 접두어 | 정규화 단계 | 잘못된 항목 제거 + 경고 로그 |
| `confidence` 범위 0~1 | 정규화 | 클램프 |
| 빈 `summary` / `assumptions` | 정규화 | `failed` (재시도) |
| `truncated=true` | 리포트 플래그 | 저신뢰 목록에 포함 |

### 9.2 시드 회귀 세트 (Golden Cards)

`data/golden-cards.json` — 알려진 충돌·중복 쌍에 속한 PR의 **기대 카드 필드** 스냅샷.

최소 시드 (README 실증 사례):

| PR | 기대 `touched_resources` (부분집합) | 기대 `domains` |
|---|---|---|
| #101471 | `state:compaction.ownership` 또는 동등 표현 | `session-state` |
| #95272 | `api:` compaction 관련, `state:compaction.*` | `session-state` |

회귀 검사 (`npm run step1:verify` — 구현 시):

1. golden PR만 재추출
2. `touched_resources` ∩ 기대셋 ≠ ∅ 인지
3. `domains` 일치 또는 `other` 아님
4. 실패 시 CI/리포트에 경고

### 9.3 수동 감사 샘플

`step1-report.md`에 자동 포함:

- `confidence < 0.5` 상위 20건 (제목 + summary)
- `truncated=true` 20건
- `touched_resources` 0개 (있으면) 전건
- 랜덤 성공 10건 — 팀 육안 검토용

### 9.4 품질 지표 (리포트)

- 추출 성공률 = `success / (success + failed)`
- 스킵률 (캐시 hit)
- 평균·p50·p90 `confidence`
- `touched_resources` / `domains` 분포 (Step 2 버킷 예상 크기)
- 접두어별 자원 빈도 (IDF 사전 계산 — Step 2 입력)

---

## 10. Step 2 연동

Step 2는 LLM 없이 카드 메타만 사용한다 (README §Step 2).

### 10.1 Step 1 → Step 2 필드 매핑

| Step 2 신호 | Step 1 소스 | 비고 |
|---|---|---|
| ① 자원 정확 일치 | `touched_resources` | 역색인 키. 인기 자원 IDF는 Step 2에서 카드 전체 집계 |
| ② 자원 유사 일치 | `touched_resources` 토큰 유사도 | 접두어 동일 + 경로 편집거리 |
| ③ 문장 임베딩 유사 | `summary` + `assumptions` | Step 1에서 선계산 **또는** Step 2 ingest 시 계산 (권장: Step 2 — 임베딩 모델 변경 유연) |
| ④ 도메인∩파일 겹침 | `domains` ∩ + `file:` 리소스 | 약한 신호 |

### 10.2 버킷 폭발 예방 (Step 1 기여)

Step 1 리포트에서 **고빈도 `touched_resources` Top 20**을 출력해 Step 2가 대형 버킷(>15 PR) 사전 식별.

카드 추출 시 LLM에게 "과도하게 일반적인 리소스 키 (`file:package.json`, `config:NODE_ENV`)는 피하고 행동 변화의 핵심 자원만" 지시.

### 10.3 Step 3·시각화 전달

- `behavior_changes` — 판정 패널 before/after 나란히 표시
- `assumptions` — 충돌 시 마주 보기 뷰
- `confidence` — Step 3 최종 severity 가중치 입력

---

## 11. 실행 인터페이스

### 11.1 npm scripts (추가 예정)

```json
{
  "step1": "tsx src/step1.ts",
  "step1:verify": "tsx src/step1.ts --verify-golden"
}
```

### 11.2 환경 변수 (`.env.example` 확장)

```bash
GITHUB_TOKEN=...
REPO=openclaw/openclaw
OPENAI_API_KEY=...              # 또는 ANTHROPIC_API_KEY
LLM_PROVIDER=openai
LLM_MODEL=gpt-4.1-mini
MAX_CARDS=                      # 비우면 전체 passed
MAX_DIFF_CHARS=24000
```

### 11.3 파이프라인 위치

```
npm run fetch → npm run step0 → npm run step1 → (Step 2)
```

---

## 12. 마일스톤

일정 기준: README · technical-plan (1주차 Step 0~1)

| 단계 | 작업 | 완료 기준 | 목표일 |
|---|---|---|---|
| **M1** | `types.ts` IntentCard 타입 · `intent-card.ts` Zod+프롬프트 | 스키마 단위 테스트 통과 | 7/8 |
| **M2** | `diff.ts` — REST 수집·캐시·트렁케이션 | `MAX_PRS=10`에서 캐시 hit 확인 | 7/9 |
| **M3** | `extract.ts` + `step1.ts` 골격 | 10 PR end-to-end → `cards.jsonl` | 7/10 |
| **M4** | 체크포인트·재개·리포트 | Ctrl-C 후 재실행 시 LLM 0회(캐시) | 7/10 |
| **M5** | `MAX_CARDS=50` 파일럿 | 성공률 >90%, 리포트 생성 | 7/11 |
| **M6** | golden-cards 회귀 + 수동 감사 | #101471/#95272 `touched_resources` 생존 | 7/11 |
| **M7** | openclaw 전량 (pass ~2.3k) | `cards.jsonl` 완료, Step 2 handoff | 7/12 |

**1주차 Exit criteria:** Step 2 팀이 `data/cards.jsonl`만으로 버킷팅 프로토타입 가능 + 품질 리포트 공유.

---

## 13. 리스크·미결정

| 항목 | 선택지 | 결정 시점 |
|---|---|---|
| 임베딩 선계산 여부 | Step 1 vs Step 2 | M5 파일럿 후 |
| `domains` 자동 vs LLM | 현재 LLM 추출 | openclaw 라벨 교차 검증 후 |
| 바이너리-only logic 파일 | patch 없음 | `confidence≤0.3`, title/body만으로 추출 |
| 다국어 summary | 한국어 고정 vs PR 언어 | 팀 시각화 언어에 맞춰 한국어 유지 |

---

## 14. 참고

- 상위 개요: `/README.md` Step 1 원칙
- 카드 필드 초안: `/technical-plan.md` §Step 1
- Step 0 I/O: `/pipeline/README.md`
- Step 0 구현 패턴: `src/fetch.ts` (체크포인트), `src/classify.ts` (logic 필터)
