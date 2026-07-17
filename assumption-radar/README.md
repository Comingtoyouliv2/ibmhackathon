# Assumption Radar

Open PR을 하나씩 리뷰하는 대신 **동시에** 읽어, 각 변경이 암묵적으로 기대하는 계약이 어디서 충돌하는지 merge 전에 설명하는 레이더입니다.

v0.2부터 전역 위험 점수를 사용하지 않습니다. v0.3은 관련성 신호와 인과 충돌 증거를 분리하고, v0.4는 Git conflict를 resolution-risk·duplicate-implementation 같은 조율 유형으로 설명합니다. v0.5는 모든 PR을 동일한 최신 target base에 정규화한 뒤 비교해 오래된 branch history가 pair conflict로 섞이는 문제를 막습니다. 판정은 재현 가능한 witness와 semantic review로 구성되며, 현재 성능과 한계는 [v0.5.0 상태](docs/STATUS-v0.5.0.md), 확장 계약은 [Framework 설계](docs/FRAMEWORK.md)를 참고하세요.

> 현재 개발 프로젝트는 이 폴더입니다. 상위 디렉터리의 `ibmhackathon/`은 이전 연구 파이프라인과 데이터를 보존하는 별도 공간입니다.

파일 충돌만 찾지 않습니다. 다음처럼 Git이 잡지 못하는 교차 PR 위험을 겨냥합니다.

- PR A는 `orders.total_amount`가 유지된다고 믿는데 PR B는 같은 컬럼을 즉시 rename한다.
- PR A는 이벤트에서 `amount`, `currency`를 제거하는데 PR B의 새 consumer는 두 필드를 당연히 받는다고 믿는다.
- PR A는 새 endpoint가 항상 활성화된다고 테스트하지만 PR B는 feature flag 기본값을 `false`로 배포한다.

## 바로 실행

Node.js 20 이상이 필요합니다.

```bash
cd assumption-radar
npm install
npm start
```

브라우저에서 `http://127.0.0.1:4317`을 열고 **샘플 레이더 보기**를 누르세요.

실제 공개 저장소는 화면에 `owner/repository`를 입력하면 됩니다. 비공개 저장소와 AI 심층 분석은 환경변수를 설정합니다.

```bash
cp .env.example .env
GITHUB_TOKEN=github_pat_... OPENAI_API_KEY=sk-... npm start
```

> 이 앱은 `.env` 파일을 자동으로 읽지 않습니다. 셸, 비밀 관리자, 배포 환경에서 환경변수로 주입하세요. 토큰은 브라우저에 노출되지 않습니다.

## CLI / CI

```bash
# 내장 데모
npm run scan -- --demo

# 실제 저장소, 규칙 기반 분석
GITHUB_TOKEN=... npm run scan -- owner/repository

# AI 강화 + deterministic conflict가 있으면 exit code 2
GITHUB_TOKEN=... OPENAI_API_KEY=... \
  npm run scan -- owner/repository --ai --fail-on conflict

# Claude를 판정기로 선택
GITHUB_TOKEN=... ANTHROPIC_API_KEY=... \
  npm run scan -- owner/repository --ai --ai-provider anthropic --fail-on conflict

# 로그인된 Codex CLI를 판정기로 선택(API key 불필요)
GITHUB_TOKEN=... npm run scan -- owner/repository \
  --preflight --ai --ai-provider codex --fail-on conflict
```

`.github/workflows/assumption-radar.yml`은 PR이 바뀔 때마다 전체 open PR을 다시 비교하는 최소 GitHub Actions 예제입니다. 이 프로젝트를 다른 저장소의 하위 폴더로 넣는다면 workflow의 `working-directory`와 npm cache 경로를 조정해야 합니다.

## 시스템 구조

```text
GitHub open PRs
      │
      ▼
Directional diff model ─ add / remove / declaration / hunk / contract / rename
      │
      ▼
Witness join ─────────── same declaration / contract lifecycle / competing replacement
      │
      ▼
Git preflight ────────── stack collapse / current-base normalization / merge-tree conflict
      │
      ├──────────────► coordination: Git conflict, semantic benchmark 제외
      ├──────────────► coordination explainer: resolution-risk / duplicate / generic
      ├──────────────► causal proof: contradiction / dependency / composition / relevance
      ├──────────────► deterministic verdict: conflict / review / independent
      │
      ▼
Bounded AI second-look ─ review + 관련성 높은 independent 후보를 판정
      │                  OpenAI 또는 Anthropic, 양측 verbatim evidence 필수
      │
      ▼
Radar UI / CLI gate
```

### 1. 수집

`src/github.mjs`가 최근 open PR 최대 100개, PR 상세 통계, PR당 최대 400개 변경 파일의 patch를 GitHub REST API에서 가져옵니다. 공개 저장소는 무토큰으로도 되지만 rate limit이 낮습니다.

### 2. 계약 신호 추출

`src/analyzer.mjs`는 diff를 추가·삭제 방향이 보존된 change model로 바꾸고 다음 신호를 구조화합니다.

- endpoint와 HTTP method
- 테이블·컬럼·migration
- event/topic/queue 이름
- 환경변수와 feature flag
- auth/permission 경계
- 공개 선언과 signature
- hunk의 원본 라인 범위와 declaration context
- 삭제, rename, 파일 생명주기

전역 점수나 저장소 공통 임계값은 없습니다. 같은 파일은 후보 관계를 만드는 proximity evidence일 뿐 경고가 아닙니다. 판정은 구체적인 witness의 종류로 결정합니다.

- `coordination`: `git merge-tree`가 기계적 충돌을 확인한 쌍. 조율 대상으로 표시하지만 silent semantic-conflict benchmark에서는 제외
- `conflict`: 파일 삭제와 수정의 경쟁, 같은 base 라인의 상이한 교체, signature 분기, 계약 제거와 새 사용, rename 후 구이름 참조
- `review`: dependency 또는 composition-risk witness가 있으나 최종 호환 여부는 통합 검증이 필요
- `independent`: causal proof가 없거나 동일 declaration 같은 relevance 신호만 존재. relevance는 비교 결과에 보존하지만 경고 예산을 쓰지 않음
- `insufficient`: patch가 없거나 분석할 근거가 부족함. 현재 API 응답에서는 independent 집계에 포함됩니다.

### 3. AI 전제 대조

실제 GitHub 분석에서는 후보 판정 전에 PR head와 target base를 로컬 bare cache에 fetch합니다. ancestor PR은 stack의 최신 descendant에 접습니다. 그다음 각 PR을 동일한 최신 target base에 먼저 적용한 가상 merge commit을 만들고, 두 가상 결과를 `git merge-tree`로 비교합니다. raw PR head끼리 직접 비교하면 브랜치가 갈라진 뒤 base에 들어간 변경까지 pair conflict로 오인할 수 있기 때문입니다.

개별 PR이 현재 base와 이미 충돌하면 그 PR이 포함된 모든 pair를 반복 경고하지 않고 `insufficient / base-conflict`로 보류합니다. 두 PR의 base-normalized 결과 사이에서만 발생한 Git conflict는 `coordination`으로 보내며 AI와 silent semantic-conflict benchmark에서는 제외합니다.

`OPENAI_API_KEY`가 있고 AI 분석이 켜져 있으면 clean merge인 `review` 쌍만 OpenAI Responses API에 보냅니다. deterministic conflict를 모델이 지울 수 없고, 동일 파일뿐인 independent pair는 모델 비용을 쓰지 않습니다. AI는 점수 대신 `conflict`, `compatible`, `uncertain` 중 하나를 반환합니다. 결과는 strict JSON Schema로 제한됩니다. 기본 모델은 `gpt-5.6-terra`이며 `OPENAI_MODEL`로 바꿀 수 있습니다.

AI가 실패하거나 키가 없어도 witness framework가 결과를 반환합니다. AI 결과는 semantic review만 대체합니다. API 요청에는 `store: false`를 지정합니다.

### 4. 설명과 판단

각 경고에는 다음이 들어갑니다.

- 충돌 또는 검토가 필요한 PR 쌍과 verdict
- verdict를 만든 witness 종류와 근거
- PR A의 숨은 전제 / PR B의 숨은 전제
- 함께 merge됐을 때의 영향
- 권장 merge 순서 또는 계약 테스트
- diff에서 추출한 근거

## API

### `POST /api/analyze`

```json
{
  "repository": "owner/repository",
  "useAI": true
}
```

### `POST /api/demo`

```json
{ "useAI": false }
```

### `GET /api/status`

GitHub/OpenAI 환경변수 설정 여부와 선택된 모델만 반환합니다. 토큰 값은 반환하지 않습니다.

## 검증

```bash
npm run check
npm test

# 평가기 자체의 synthetic smoke test
npm run eval:smoke

# 실제 annotated JSONL 평가
npm run eval -- benchmarks/your-benchmark.jsonl
```

테스트는 동일 파일의 독립적 변경 제외, 같은 base 라인의 경쟁 교체, DB rename과 구이름 사용, 이벤트 제거와 새 consumer, AI의 semantic review 해소, deterministic conflict 보호를 검증합니다.

제품 판정에는 하나의 전역 점수를 쓰지 않지만, detector 개발과 릴리스 판단에는 정량 평가가 필요합니다. [Semantic Conflict Detection Rubric](docs/EVALUATION_RUBRIC.md)은 triage recall, blocker precision, abstention, evidence 품질, 저장소·언어별 일반화, detector별 기여도를 서로 분리해 측정합니다. 기계가 읽는 정의는 [`eval/rubric.json`](eval/rubric.json)에 있습니다.

## 폴더 구조

| 경로 | 내용 |
|---|---|
| `src/` | analyzer, GitHub 수집, AI resolver, CLI/server |
| `public/` | 로컬 Radar UI |
| `demo/` | `synthetic-prs.json` UI 시연 전용 가상 PR 데이터 |
| `docs/` | framework와 평가 설계 문서 |
| `eval/` | 평가 CLI와 기계 판독 Rubric |
| `test/` | 코드 회귀 테스트와 synthetic fixture |
| `benchmarks/` | 실제 PR 라벨과 production 후보를 둘 공간 |

## 운영으로 가져갈 때

### Historical replay 후보 자동 필터

merge-history 후보는 fix와 blamed lineage가 같으면 하나의 가족으로 접고, 구조화된 counterfactual evidence로 자동 판정할 수 있습니다.

```bash
GITHUB_TOKEN="$(gh auth token -h github.com)" npm run filter:replay -- \
  benchmarks/merge-history/microsoft__vscode-2026-07-16-replay-queue/review-candidates.jsonl \
  --evidence benchmarks/merge-history/microsoft__vscode-2026-07-16-replay-queue/replay-evidence.jsonl \
  --github \
  --output-dir benchmarks/replay-filter/microsoft__vscode-2026-07-16-github
```

결정 규칙:

- 같은 증상의 명시적 closing issue가 두 원인 PR보다 먼저 생성됨 → `pre-existing-defect`
- base에서 사용자 관찰 가능한 실패 → `pre-existing-defect`
- A 또는 B 단독과 A+B가 실패하고 fixed가 통과 → `single-parent-*-bug`
- A·B 단독 통과, A+B만 실패, fixed 통과 → `pair-induced-conflict`
- base 내부 로직 실패만 있고 사용자 경로가 증명되지 않음 → `insufficient`

자동 판정은 독립 PR 범위와 완전한 evidence가 있을 때만 pair benchmark에 들어갑니다. GitHub 전체 URL의 repository도 보존하므로 private engineering issue를 같은 번호의 public issue로 오인하지 않습니다.

현재 구현은 날카로운 MVP입니다. 실제 팀 배포 전에는 다음 순서로 확장하는 것이 좋습니다.

1. GitHub App으로 바꾸고 installation token을 사용합니다. PAT를 팀 서버에 공유하지 않습니다.
2. webhook의 PR head SHA를 키로 diff·추출 결과를 캐시해 변경된 PR 쌍만 재분석합니다.
3. 결과를 GitHub Check Run으로 게시하고 `conflict`만 merge gate, `review`는 정보성 경고로 둡니다.
4. 저장소별 adapter는 임계값 대신 프레임워크에 새 witness extractor로 추가합니다. 예: Protobuf field lifecycle, Terraform resource address, GraphQL schema, Kafka/AsyncAPI payload.
5. patch가 생략되는 binary/대형 diff는 checkout 기반 분석이나 GitHub blob fetch로 보완합니다.

## 보안과 한계

- diff 내용은 AI 모드를 켰을 때만 OpenAI API로 전송됩니다. 민감 저장소는 조직 정책과 API 데이터 정책을 먼저 확인하세요.
- 토큰은 서버 환경변수로만 두고 UI나 URL에 넣지 마세요.
- 규칙 엔진은 언어 독립적 패턴을 우선해 AST 수준의 완전한 의미 분석은 하지 않습니다.
- 두 PR이 같은 base에서 테스트됐다는 사실은 통합 상태의 안전을 보장하지 않습니다. 이 레이더는 조율할 대상을 좁히는 도구이지, 테스트를 대체하지 않습니다.
