# 7/20 스캔 결과 — 7개 레포 + 재현성 검증 + Builder/Kind 억제 규칙 검토

작성: 2026-07-20 · 실행자: 팀원 · 코드: `Comingtoyouliv2/ibmhackathon`

---

## 0. 핵심 요약

1. **재현성 확인 ✅** — 팀원과 **동일 커밋(`6e3548e`)** 으로 4개 레포를 독립 실행한 결과, 결정적 층이 **3/4 완전 일치**(undertow·jackson-databind·lombok). mockito만 PR 드리프트(38→37, 30분 차이).
2. **7/19 대비 결정적 semantic conflict 7건이 사라진 것을 확인** — opensearch 6건 + lombok 1건.
3. **원인은 버그가 아니라 의도된 오탐 억제** — `dbc2076`이 추가한 `UNRESOLVED_CROSS_FILE_SYMBOLS = {builder, kind}` 규칙. (최초 이 문서는 "회귀"로 기술했으나 코드 확인 후 정정)
4. **남는 질문**: 이 억제가 **참 양성까지 지웠는지** 확인 필요. 아래 골든 케이스 후보 7건 제시.

---

## 1. 실행 조건

| 항목 | 값 |
|---|---|
| 실행 시각 | 2026-07-20 20:21 KST (팀원: 19:50 KST, 약 30분 차) |
| 애플리케이션 | Assumption Radar 1.0.0 |
| Git commit | `6e3548e` (팀원과 **동일**), 비교군 `9cf9abe` |
| AI provider | **사용 안 함 (결정적 분석만)** |
| 명령 | `npm run scan -- <owner/repo> --limit <N> --preflight` |
| Docker Base/A/B/A+B | 미실행 |

**AI 미사용 이유**: LLM은 bounded second-look(팀원 기준 34 pair)에만 쓰이고, 결정적 층은 모델과 무관합니다. 따라서 이 리포트의 수치는 팀원(gpt-5.6-sol) 결과와 **직접 비교 가능**하며, 재현성 검증에 적합합니다.

---

## 2. 재현성 검증 — 팀원 4개 레포 결과와 대조

동일 커밋 · 동일 레포 · 독립 실행. **결정적 층만 비교**(AI 판정 제외).

| Repository | PR (팀원/나) | pair (팀원/나) | coordination | insufficient | 판정 |
|---|---|---|---|---|---|
| undertow-io/undertow | 44 / 44 | 946 / 946 | 4 / 4 | 311 / 311 | ✅ **완전 일치** |
| FasterXML/jackson-databind | 25 / 25 | 300 / 300 | 0 / 0 | 19 / 19 | ✅ **완전 일치** |
| mockito/mockito | 38 / 37 | 703 / 666 | 1 / 1 | 142 / 133 | ⚠️ PR 드리프트 |
| projectlombok/lombok | 42 / 42 | 861 / 861 | 2 / 2 | 330 / 330 | ✅ **완전 일치** |

> **결론: 결정적 파이프라인은 재현 가능합니다.** mockito 차이는 30분 사이 open PR 이 1개 변동한 것으로, 코드 문제가 아닙니다.

### semantic conflict 수치가 달라 보이는 이유

팀원 표의 `Raw semantic conflict 1`(jackson) 과 `Raw review 1`(lombok) 은 **모두 AI second-look 산출물**입니다. 저는 AI를 쓰지 않았으므로 정의상 0입니다. **결정적 층에서는 양쪽 모두 0으로 일치**합니다.

또한 팀원이 그 2건을 3회 반복 판정한 결과가 갈렸습니다:
- jackson `#5715 × #6075`: `review / conflict / conflict`
- lombok `#3678 × #3874`: `independent / review / independent`

→ **AI 판정의 재현성이 낮다**는 중요한 발견이며, 아래 5장 권고와 직결됩니다.

---

## 3. 7/19 → 7/20 사이 결정적 conflict 7건 소실 — 원인 규명

### 3.1 사실 확인

팀원 7/19 리포트(커밋 `9cf9abe`)의 opensearch 결정적 conflict 6건이 현재 main에서 0건이 되어, 원인을 추적했습니다.

**PR 드리프트 배제**: 지목된 PR 5개(#1957, #2002, #2040, #2041, #2062)가 전부 아직 open이고 분석 대상에도 포함됨을 API로 확인.

**동일 스냅샷 A/B 실행** (worktree로 `9cf9abe` 체크아웃, 같은 날 같은 PR 대상):

| 대상 | `9cf9abe` | `6e3548e` (main) | 그 외 수치 |
|---|---:|---:|---|
| opensearch-java 결정적 conflict | **6** | **0** | PR·pair·coordination·insufficient 완전 동일 |
| lombok 결정적 conflict | **1** | **0** | 나머지 완전 동일 |

이분 탐색 결과 **`dbc2076`** 에서 변화가 시작됩니다.

### 3.2 원인: 의도된 오탐 억제 규칙

`dbc2076` (`feat: improve cross-language conflict retrieval`) 이 `src/analyzer.mjs` 에 추가한 코드:

```js
// These names are commonly nested in unrelated generated/domain types. Without
// a resolved owner, matching them across files turns proximity into a false
// direct conflict (for example ShardProfile.Builder vs GrpcTlsConfig.Builder).
const UNRESOLVED_CROSS_FILE_SYMBOLS = new Set(["builder", "kind"]);
```

적용 지점 2곳:
1. **arity 변경 대조** — 선언 파일과 호출 파일이 다르고 심볼이 `builder`/`kind` 면 skip
2. **제거된 심볼 vs 새 참조** — 참조가 전부 다른 파일에 있고 심볼이 `builder`/`kind` 면 skip

**이는 버그가 아니라 명시적 설계 결정입니다.** 주석이 `ShardProfile.Builder vs GrpcTlsConfig.Builder`(opensearch 실제 사례)를 직접 인용하고 있어, 한 팀원이 7/19 결과를 보고 오탐으로 판단해 막은 것으로 보입니다.

소실된 7건의 내역이 정확히 이 규칙의 대상입니다:
- opensearch: Builder 인자 수 변경 5건 + `Kind` 제거 1건
- lombok: `lombok.Builder` binding 제거 1건

> ⚠️ **정정**: 이 문서 최초 버전은 위 현상을 "회귀"로 기술했습니다. 코드 확인 결과 의도된 변경이므로 철회합니다.

---

## 4. 신규 4개 레포 스캔 결과 (팀원 지시)

전체 open PR 대상, 현재 main.

| Repository | PR | pair | 결정적 conflict | coordination | insufficient |
|---|---:|---:|---:|---:|---:|
| undertow-io/undertow | 44 | 946 | 0 | 4 | 311 |
| FasterXML/jackson-databind | 25 | 300 | 0 | 0 | 19 |
| mockito/mockito | 37 | 666 | 0 | 1 | 133 |
| projectlombok/lombok | 42 | 861 | 0 | 2 | 330 |
| **합계** | **148** | **2,773** | **0** | **7** | **793** |

> ⚠️ **`--limit` 기본값이 20입니다.** 생략하면 4개 레포 모두 20 PR(760 pair)만 스캔됩니다. 처음 실행에서 발견해 명시적 limit으로 재실행했습니다. 팀원도 같은 함정을 겪고 "상위 20개 보고서는 폐기"하셨습니다 — **팀 공통 이슈**입니다.

---

## 5. 팀 논의 안건 — 억제 규칙 보정이 필요한가

`UNRESOLVED_CROSS_FILE_SYMBOLS` 는 **심볼 이름 2개(`builder`/`kind`)에 대한 전면 억제**입니다. 정밀도는 올라가지만, 다음이 열린 질문입니다.

**Q. 참 양성까지 지웠는가?**

현재 어느 쪽도 판정할 근거(ground truth)가 없습니다. 아래 7건이 **판정 대상 골든 케이스 후보**입니다 — `9cf9abe`는 conflict라 하고 main은 아니라고 하는 케이스들입니다.

| # | Repository | PR pair | 유형 |
|---|---|---|---|
| 1–5 | opensearch-java | `#2040×#1957`, `#2041×#1957`, `#2062×#2041`, `#2062×#2040`, `#2062×#1957` | Builder arity 변경 |
| 6 | opensearch-java | `#2002×#1957` | `Kind` 제거 vs 새 참조 |
| 7 | projectlombok/lombok | `#4052×#3874` | `lombok.Builder` binding 제거 vs 새 사용 (`HandleBuilder.java`) |

**제안**: 이 7건을 Docker Base/A/B/A+B 로 실제 실행 검증하면 참/거짓이 확정됩니다. 그 결과를 팀원 하네스의 고정 픽스처로 넣으면:
- 참 양성이었다면 → 억제 규칙을 **심볼 이름이 아니라 타입 소유자(owner) 해석 기반**으로 정교화해야 함
- 거짓 양성이었다면 → 현재 규칙이 옳고, **정밀도 개선 성과로 기록**

어느 쪽이든 팀의 "performance 기준표"에 들어갈 **최초의 실측 데이터**가 됩니다.

---

## 6. 권고

1. **골든 케이스 7건을 Docker 검증으로 판정** → 억제 규칙의 정오 확정. 회의 안건 2번("임팩트 있는 pair-induced regression 찾기")에 바로 쓸 수 있는 재료입니다.
2. **AI 판정 불안정성 대응** — 팀원이 확인한 3회 반복 불일치(`review/conflict/conflict`, `independent/review/independent`)는 성능 지표의 신뢰도를 직접 훼손합니다. 기준표에 **동일 입력 N회 반복 일치율(재현성)** 을 지표로 포함할 것을 제안합니다.
3. **`--limit` 기본 20 공지** — 팀원 전원 확인 필요. 과거 측정치 중 limit 미지정 실행은 재실행 대상입니다.
4. **비교 시 커밋 SHA + 실행 시각 + 수집 PR 수 3종 세트 필수 기록** — 오늘 mockito 사례(30분 차이로 38→37)처럼 raw count 는 쉽게 어긋납니다.

---

## 7. 해석 경계

- 2026-07-20 live open-PR snapshot. 실행 시각·PR 목록·base SHA 가 다르면 raw count 를 정확도 차이로 해석 금지.
- semantic conflict / git coordination / insufficient 는 **서로 다른 게이트**. 합산 비교 금지.
- Docker Base/A/B/A+B 미실행 → confirmed pair regression 0건. 위 conflict 판정은 실행 재현 결과가 아님.
- 이 리포트는 **결정적 분석만** 사용. AI 판정이 없으므로 모델 선택과 무관하게 팀원 간 직접 비교 가능.

---

## 8. 재현 방법

```bash
cd assumption-radar && npm install
# .env 에 GITHUB_TOKEN (.gitignore 등록 완료)

node eval/run-three-repo-report.mjs --tag main \
  undertow-io/undertow:44 FasterXML/jackson-databind:25 \
  mockito/mockito:37 projectlombok/lombok:42

# 억제 규칙 이전과 비교
git worktree add --detach /tmp/pre 9cf9abe
cd /tmp/pre/assumption-radar && npm install && node eval/run-three-repo-report.mjs --tag pre <동일 인자>
```

산출물: `reports/pr-conflict-live-deterministic-<tag>-<date>.md` + `raw-*.json`

> **환경 함정**: 일부 셸이 `GIT_CONFIG_COUNT/KEY/VALUE` 로 `safe.bareRepository=explicit` 를 주입하면 preflight 가 bare 캐시를 다루지 못해 **git merge-tree 검사가 통째로 스킵되고 coordination·insufficient 가 조용히 0** 이 됩니다(에러 없음). 러너에 제거 로직 포함.