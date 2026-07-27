# 임팩트 케이스 후보 — Apache Fineract (+ Claude second-look 실측)

작성: 2026-07-27 · 실행자: 팀원 · **결정적 분석 + Claude(claude-opus-4-8) second-look 실행 / Docker 미실행**

> **요약**: 금융 인프라 레포를 결정적 층으로 스캔해 fineract 에서 conflict 8건을 뽑고, **Claude(Anthropic API)를 8쌍 × 3회 = 24콜 돌려 판정**했다. money cluster **#6110×#6024 는 Claude 3/3 안정 compile-level conflict**(이자계산 경로 인식). 동시에 **Claude 가 결정적 층의 오탐 2건을 걸러냈으며**, 8건 전체에서 **silent-runtime(진짜 임팩트) 은 0건** — 우리 케이스는 전부 CI 가 잡는 compile-level 임을 AI 가 독립 확인했다.

---

## 0. 한 줄 결론

- 결정적 층 conflict 8건 → **Claude second-look: conflict-STABLE 4건(전부 compile-level), not-conflict-STABLE 2건(=결정적 오탐), UNSTABLE 2건.**
- **가장 강한 케이스 = #6110×#6024** (저축계좌 `getActivationDate` rename, 이자계산 경로, Claude 3/3 안정).
- **silent-runtime 0건** → 현재 케이스는 전부 "합치면 컴파일이 깨진다" 유형 → **직접 금액 손실은 보수적으로 0원.** 진짜 임팩트(합쳐도 CI 초록불인데 로직만 틀림)는 아직 미발견.

---

## 1. 무엇을 돌렸나

다른 팀원과 안 겹치도록 **비-crypto 금융 인프라** 를 대상으로 잡음.

| Repository | 도메인 | open PR | pair | 결정적 conflict | 결과 |
|---|---|---:|---:|---:|---|
| killbill/killbill | 결제·청구 플랫폼 | 22 | 231 | 1 | ⚠️ 오탐 (base 브랜치 다름, 6장) |
| formancehq/ledger | 원장 (Go) | 20 | 190 | 0 | 없음 |
| **apache/fineract** | **마이크로파이낸스 뱅킹 코어** | **74** | **2,701** | **8** | ✅ 유효 후보 다수 → Claude 판정 |

fineract conflict 8건은 전부 같은 base(`develop`). preflight `complete`, clean 1,197 / textual-conflict 67.

**2층 판정 흐름**: (1) 결정적 층 = git merge-tree + 심볼 분석으로 후보 8쌍 추출 → (2) Claude second-look = 각 쌍의 verbatim 코드 인용을 넘겨 conflict 실재/유형/금액경로/신뢰도를 3회씩 판정.

---

## 2. Claude second-look 실측 결과 (핵심)

**실행 조건**: `claude-opus-4-8` · effort `medium` · thinking adaptive · temperature 없음(Opus 4.8 은 sampling 파라미터 400) · 8쌍 × 3회 = 24콜 · 토큰 input 23,328 / output 15,666.

| 충돌 쌍 | 유형(결정적) | Claude 3회 판정 | 안정성 | money-path |
|---|---|---|:--:|:--:|
| **#6110 × #6024** | rename (저축계좌) | compile-level ×3 | ✅ **STABLE** | 💰 |
| #6024 × #6015 | rename (저축계좌) | compile-level ×3 | ✅ STABLE | — |
| #6158 × #6151 | rename (대출테스트) | compile-level ×3 | ✅ STABLE | — |
| #6158 × #6078 | rename (스케줄러) | compile-level ×3 | ✅ STABLE | — |
| #6021 × #6024 | rename (저축계좌) | compile / compile / **not-conflict** | ⚠️ UNSTABLE | 💰(부분) |
| #6158 × #6133 | rename (대출테스트) | compile / compile / **not-conflict** | ⚠️ UNSTABLE | — |
| #6158 × #5895 | rename (대출테스트) | not-conflict ×3 | ✅ STABLE | — |
| #6158 × #6169 | 중복선언 (Swagger) | not-conflict ×3 | ✅ STABLE | — |

**요약**: conflict-STABLE 4건 (전부 compile-level) · not-conflict-STABLE 2건 (결정적 오탐 후보) · UNSTABLE 2건. **silent-runtime = 0건.**

원본 판정 로그: `reports/anthropic-judge-fineract-2026-07-27.json`

---

## 3. 가장 강한 케이스 — #6110×#6024 (Claude 3/3 안정 · 돈 경로 인식)

**허브 PR [#6024](https://github.com/apache/fineract/pull/6024) "FINERACT-2652: Decouple SavingsAccount"** 가 `SavingsAccount.java` 에서 **`getActivationDate()` → `getActivatedOnDate()` 로 rename**. [#6110](https://github.com/apache/fineract/pull/6110) 의 새 코드는 여전히 옛 이름을 참조 → A+B 컴파일 실패. git merge 는 clean.

**Claude 판정 (3회 전부 compile-level conflict, run2 는 money=true):**

> *"한 PR이 getActivationDate 를 getActivatedOnDate 로 rename 하고 다른 PR의 새 코드가 여전히 getActivationDate() 를 호출하면 존재하지 않는 메서드 참조로 컴파일 에러가 발생한다. 이는 정적 타입 단계에서 CI가 잡는 compile-level 충돌이다."*
>
> money: *"getActivationDate() 는 이자 계산 기준일(startInterestCalculationDate 비교, transactionDate 인자)에 사용되어 금액 경로에 닿지만, 컴파일 에러이므로 CI가 병합 시 잡아 런타임 손실은 0으로 보수 처리."*

돈 경로 근거 (verbatim):
```java
startInterestCalculationLocalDate = getActivationDate();
final Object[] defaultUserArgs = Arrays.asList(transactionDate, getActivationDate()).toArray();
```
→ 저축계좌 활성일 = 이자가 붙기 시작하는 날. Claude 도 이 경로를 인식했으나, **compile-level 이라 CI가 잡음 = 직접 손실 0** 이라는 caveat 을 독립적으로 재확인.

---

## 4. Claude 가 결정적 층 오탐을 걸러낸 2건 (2층 툴의 가치 실증)

**AI second-look 이 결정적 후보를 반려**한 사례:

### 4.1 #6158×#6169 — "중복선언" 반려 (STABLE not-conflict ×3)
결정적 층: 두 PR이 `public Long id;` 를 중복 추가 → 병합 시 중복선언. **Claude 반려:**
> *"Swagger DTO 의 id 필드는 보통 여러 nested static class 에 각각 존재하므로 중복 선언이 실제로 발생함을 입증하는 인용이 존재하지 않는다."*

→ Swagger 문서화 클래스의 `id` 는 흔한 필드라, 서로 다른 nested class 면 충돌 아님. 결정적 층의 **심볼-이름 단순매칭 한계**를 AI가 정확히 지적.

### 4.2 #6021×#6024 — 교차참조 의심 반려 (UNSTABLE)
run1·2 는 compile-level 이라 했지만 **run3 는 not-conflict:**
> *"rename(getActivationDate→getActivatedOnDate)과 old name 사용이 모두 SavingsAccount.java 안에 있어 PR-B 단일 도메인 변경으로 보인다. PR-A(#6021, Group 엔드포인트)가 SavingsAccount 의 해당 메서드를 참조한다는 근거가 인용에 없다."*

→ **rename 과 옛 이름 사용이 같은 파일(#6024) 내부일 수 있음 = PR간 교차충돌이 아니라 #6024 자체 내부 변경**일 가능성. 결정적 층이 파일 소유자(owner) 해석 없이 심볼만 보고 쌍으로 묶은 약점을 AI가 포착. (단 3회 중 2회는 여전히 conflict 라 판정 불안정.)

**교훈**: 결정적 층은 재현성·속도가 강점이지만 심볼 소유자 해석이 약함 → AI second-look 이 오탐 필터로 실제 기능함을 실측으로 확인.

---

## 5. AI 판정 불안정성 재현 (팀 공통 발견 확인)

다른 팀원이 관찰한 "동일 입력 3회 반복이 갈림" 현상을 **이번에도 2건에서 재현**:
- #6021×#6024: `compile-level / compile-level / not-conflict`
- #6158×#6133: `compile-level / compile-level / not-conflict`

→ **AI 단독 판정을 자동 blocker 로 쓰면 안 됨.** 기준표에 "동일 입력 N회 반복 일치율(재현성)" 을 지표로 넣자는 제안이 이 데이터로 다시 뒷받침됨. (반대로 #6110×#6024 처럼 3/3 일치하는 케이스가 신뢰도 높은 후보.)

---

## 6. 부수 발견 — killbill 오탐 (base 브랜치 상이)

killbill [#1932](https://github.com/killbill/killbill/pull/1932)(→`master`) × [#1933](https://github.com/killbill/killbill/pull/1933)(→`maint-for-0.22.x`) 은 **base 브랜치가 달라 같은 곳에 병합될 일이 없음 = 오탐.** → 후보쌍은 반드시 **같은 base 브랜치** 인지 먼저 확인. (다른 팀원 케이스는 "같은 develop" 을 확정 조건에 넣어 이미 반영됨.)

---

## 7. 정직한 한계 (과장 금지)

1. **8건 전부 compile-level, silent-runtime 0건.** Java 정적 타입이라 CI 가 병합 후 잡음 → **직접 런타임 금액 손실은 보수적으로 0원.** Claude 도 8건 모두 이렇게 판정.
2. **Docker A/B/A+B 미실행.** 결정적 witness + Claude 판정 + base 확인까지 = **강한 후보이지 confirmed 아님.** A+B 빌드로 컴파일 실패를 실제 재현해야 confirmed 승격.
3. **진짜 임팩트(silent) 는 아직 미발견.** 합쳐도 컴파일·테스트 다 통과하는데 로직만 틀린 케이스라야 "돈이 실제로 샌다" 가 성립. → silent 발굴엔 결정적 후보 풀 확대 또는 Docker 런타임 differential 이 필요.

---

## 8. 영상/심사 관점 제안

- **약한 프레이밍(피할 것)**: "A+B 하면 컴파일 안 됨" → *"그거 CI 가 잡잖아요?"* 로 무너짐.
- **강한 프레이밍(권장)**: **"git 은 병합 가능이라 하고 두 PR 각각 CI 초록불인데 합치면 깨지고, 리뷰 코멘트 어디에도 경고가 없었다"** + **"AI second-look 을 3회 돌려 3/3 일치로 재확인, 동시에 AI 가 결정적 오탐 2건을 걸러냈다"** → 2층 툴의 신뢰도·정밀도를 동시에 제시.
- **가장 강한 케이스(아직 미발견)**: silent 로직 충돌 1건. 확보 시 임팩트 압도적.

**제안 3케이스 배치**:
1. (있으면) silent 로직 충돌 = "CI·git 다 통과하는데 틀림" (최강, 미발견)
2. **#6110×#6024** = "git clean + 양쪽 green + 이자계산 도메인, Claude 3/3 안정 판정" (돈 경로 + AI 재확인)
3. **#6158×#6169 반려** = "결정적 층이 잡았지만 AI 가 오탐이라 반려" (정밀도 스토리)

---

## 9. 재현

```bash
cd assumption-radar && npm install   # .env 에 GITHUB_TOKEN, ANTHROPIC_API_KEY

# 1) 결정적 스캔 (후보 추출)
node eval/run-three-repo-report.mjs --tag money2 apache/fineract:76

# 2) Claude second-look (후보 8쌍 × 3회)
node eval/judge-anthropic-candidates.mjs --repeats 3 --effort medium

# 3) (Docker 있으면) A+B 실제 재현으로 confirmed 승격
node src/cli.mjs apache/fineract --limit 76 --preflight --verify --verify-limit 3
```
원본: `reports/anthropic-judge-fineract-2026-07-27.json`