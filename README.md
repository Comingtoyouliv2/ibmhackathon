# PR×PR — 열린 PR 간 의미 충돌 탐지기

> **Workspace status:** `pipeline/`은 TypeScript 연구·수집 파이프라인이고, [`assumption-radar/`](assumption-radar/)는 통합 탐지기와 공통 평가 하네스입니다. `pipeline/data/`는 재라벨 전까지 현재 benchmark가 아닙니다.

> 따로 보면 멀쩡한데 합쳐지면 서로의 전제를 깨뜨리는 PR 쌍을, 병합 전에 찾아서 이유와 함께 보여준다.

## 문제

AI 코딩 에이전트가 PR을 대량 생산하면서 대형 오픈소스엔 열린 PR이 수천 개씩 쌓인다 (openclaw/openclaw: 2,813개, 2026-07 실측). 기존 도구는 전부 [PR ↔ main] 축만 검사한다 — 각자 CI 통과, git 충돌 없음이면 통과. 그런데 **두 PR이 각자는 무결한데 합쳐진 상태에서만 로직이 깨지는** semantic merge conflict는 이 검사망을 전부 통과한다. 결함이 어느 한 PR이 아니라 "조합"에만 존재하기 때문이다.

실증 사례: [#101471](https://github.com/openclaw/openclaw/pull/101471)(엔진이 compaction 소유 시 overflow 감시 스킵) × [#95272](https://github.com/openclaw/openclaw/pull/95272)(에이전트 self-compaction 추가). 각자 모범적 테스트를 갖췄지만 테스트 환경이 서로소 — "엔진 있음 + 버튼 있음" 조합은 아무도 검증하지 않았다. 상세: `증거자료_충돌사례_101471x95272.md`

## 접근

핵심 설계는 **LLM 샌드위치**다. 의미 이해(비쌈)는 PR당 1회와 쌍당 1회로 제한하고, 조합 폭발 구간(수백만 쌍)은 결정적 규칙으로 커팅한다.

```
open PR 2,813
  │ Step 0  룰 기반 필터 (LLM 없음) — 문서/테스트/의존성 PR 제외
  ▼ 2,310
  │ Step 1  Intent Card 추출 (LLM, PR당 1회) — 의도·행동변화·공유자원·가정을 카드로
  ▼ 카드 N장
  │ Step 2  버킷팅 & 프루닝 (LLM 없음) — 자원 역색인 + 임베딩 유사 + 이슈참조 → 점수 상위 K쌍
  ▼ 후보 ~50쌍
  │ Step 3  관계 판정 (IBM Bob / Opus 4.8, 쌍당 1회) — 유형·심각도·신뢰도·이유·확인방법
  ▼
  시각화  PR 그래프: 노드=PR, 엣지=관계 (빨강=충돌, 노랑=불확실, 보라=중복, 회색=무해)
```

### 단계별 설계 원칙

**Step 0 — 배제는 100% 확실할 때만.** 파일 경로 glob 분류(docs/test/deps/config/assets/logic) 후 logic 파일이 1개라도 있으면 통과. 모든 판정에 `reason`을 남겨 감사 가능. git 충돌 PR은 버리지 않고 `deferred`(리베이스 후 복귀). 의존성 봇만 작성자 기준 제외 — AI 에이전트 PR은 우리의 표적 모집단이므로 통과시킨다.

**Step 1 — 기계가 조인하는 곳만 구조화, 판단 재료는 문장으로.** 카드 = summary + behavior_changes(surface/before/after) + touched_resources(접두어 `state: config: api: schema: event: file:` — 충돌이 전파되는 통로의 종류) + assumptions(이 PR이 계속 참이라 기대하는 것 — 판정의 재료) + confidence. 스키마와 추출 프롬프트는 한 파일에서만 관리해 추출자 간 형식 불일치를 차단.

**Step 2 — 후보 생성은 4개 신호의 합산 점수.** ① 자원 정확 일치(강, 인기 자원은 IDF 삭감) ② 자원 유사 일치(중) ③ 문장 임베딩 유사(중 — 이름 흔들림·누락의 안전망, 쌍별 LLM 호출 없이 확장 가능) ④ 도메인∩파일 겹침(약). 대형 버킷(>15)은 쌍 생성 스킵(제곱 폭발 방지). 임계값이 아닌 **예산 방식**(상위 K=50)으로 커팅. false negative는 시드 회귀 세트(확인된 진짜 쌍의 생존 검사) + 기각 쌍 샘플 재판정으로 측정.

**Step 3 — 열고 나서 조인다.** "충돌인가?"를 먼저 묻지 않는다(yes-bias 방지). ① 병합 상태의 상호작용을 자유 기술 → ② 공유 자원의 소유권/수명 규칙 대조, 가정 상호 검증(의무 체크) → ③ 관계 유형 분류: `semantic_conflict / duplicate / supersedes / depends_on / complements / unrelated` → ④ 충돌이면 심각도·신뢰도·근거 인용·**확인 방법**(사람이 볼 코드 지점 — 이것 없는 충돌 판정은 무효). 판정 불가면 정직하게 `uncertain`(그래프의 노란 엣지, Bob 코드 검사 대기열). 품질은 양성/음성 대조군과 재현성 테스트로 측정. Bob의 검사 도구로 레포 코드를 직접 열어 uncertain을 확정 판정으로 승격 — 세션 리포트 export가 제출물.

**시각화 — 그래프 + 판정 패널 + 깔때기.** 후보 쌍에 걸린 PR만 렌더(~70 노드). 엣지 클릭 → 두 카드 나란히, 충돌하는 가정 마주 보기, 확인 체크리스트. 데이터 계약은 Step 2/3 출력 JSONL 그대로.

## 현재 상태

| 단계 | 상태 |
|---|---|
| Step 0 | ✅ 구현 완료, openclaw 2,813개 실측 (pass 82.1%) — `pipeline/` |
| Step 1 | 설계 확정, 구현 대기 |
| Step 2 | 설계 확정 (`설계_Step2_버킷팅프루닝.md`), 구현 대기 |
| Step 3 | 설계 진행 중 (관계 유형 확장 반영), Bob 파일럿 예정 |
| 시각화 | 컨셉 목업 완료, 프론트 구현 대기 (담당: 최원재) |

## 실행 (Step 0)

```bash
cd pipeline
cp .env.example .env   # GITHUB_TOKEN 설정
npm install
npm run fetch          # open PR 수집 (중단해도 이어받기 됨)
npm run step0          # 분류 + 리포트 → data/report.md, data/step0.csv
```

상세: `pipeline/README.md`

## 저장소 구조

```
pipeline/               Step 0 구현 (TypeScript)
팀공유_핵심정리.md        팀 온보딩용 개념 정리
증거자료_충돌사례_*.md    실제 충돌 후보 쌍 정밀 분석
설계_Step2_*.md          Step 2 설계 문서
```

## 일정 (2026-07-07 → 07-30)

1주차 Step 0~1 + 카드 품질 검증 · 2주차 Step 2~3 + Bob 파일럿 + 시각화 구현 · 3주차 실레포 end-to-end + 백/프론트 통합 · 7/25~ 데모 영상.
