# Assumption Radar 4개 Java OSS 전체 open PR live scan — deterministic only

## 결론

4개 저장소의 **전체 open PR 148개, 2,773쌍**을 분석했다. 결정적(deterministic) semantic conflict **0건**, review **2건**, **Git text coordination 7건**이 확인됐다.

> **AI second-look 을 실행하지 않았다.** 이 수치는 순수 결정적 분석 결과이며, 모델 선택과 무관하므로 다른 팀원 결과와 직접 비교 가능하다.

Docker Base/A/B/A+B 결합 실행은 하지 않았다. 따라서 아래 판정은 실행으로 재현된 충돌이 아니다.

## 실행 조건

| 항목 | 값 |
|---|---|
| 실행 시각 | 2026-07-20 20:21–2026-07-20 20:24 KST |
| 애플리케이션 | Assumption Radar 1.0.0 |
| Git commit | `6e3548e` |
| 입력 범위 | 실행 시점의 전체 open PR |
| 분석 범위 | 148 PR, 2,773 pair |
| Git 검사 | 관련성이 있는 1,669 pair 를 current base 기준 `git merge-tree` 로 검사 |
| AI | **사용 안 함 (결정적 분석만)** |
| 실행 검증 | Docker Base/A/B/A+B 미실행 |

## 저장소별 결과

| Repository | 전체 open PR | Pair | Semantic conflict | Review | Git coordination | Insufficient | Independent |
|---|---:|---:|---:|---:|---:|---:|---:|
| [undertow-io/undertow](https://github.com/undertow-io/undertow/pulls) | 44 | 946 | 0 | 1 | 4 | 311 | 630 |
| [FasterXML/jackson-databind](https://github.com/FasterXML/jackson-databind/pulls) | 25 | 300 | 0 | 0 | 0 | 19 | 281 |
| [mockito/mockito](https://github.com/mockito/mockito/pulls) | 37 | 666 | 0 | 0 | 1 | 133 | 532 |
| [projectlombok/lombok](https://github.com/projectlombok/lombok/pulls) | 42 | 861 | 0 | 1 | 2 | 330 | 528 |
| **합계** | **148** | **2,773** | **0** | **2** | **7** | **793** | **1,971** |

`Independent` 1,971건 중 1,971건은 deterministic 무경고 후 미검토인 `no-alert-unreviewed` 다. 따라서 전체 호환성 증명으로 해석하면 안 된다.

## Semantic 판정 상세

### undertow `#1981 × #1365` — review

- 대상: [#1981](https://github.com/undertow-io/undertow/pull/1981) × [#1365](https://github.com/undertow-io/undertow/pull/1365)
- 제목: servlet/src/main/java/io/undertow/servlet/spec/ServletOutputStreamImpl.java의 같은 기존 동작을 다르게 교체함
- 요약: 두 PR이 동일한 base 라인을 제거하고 서로 다른 구현을 넣습니다. Git이 잡는 텍스트 충돌인지 의미 충돌인지 구분해야 합니다.
- 카테고리: `behavior`
- 근거: `servlet/src/main/java/io/undertow/servlet/spec/ServletOutputStreamImpl.java`, `} finally {`, `write`
- 권장 조치: causal witness가 가리키는 경로를 대상으로 교차 테스트를 추가하고 담당자 확인을 받으세요.

### lombok `#3874 × #3678` — review

- 대상: [#3874](https://github.com/projectlombok/lombok/pull/3874) × [#3678](https://github.com/projectlombok/lombok/pull/3678)
- 제목: src/core/lombok/Builder.java의 같은 기존 동작을 다르게 교체함
- 요약: 두 PR이 동일한 base 라인을 제거하고 서로 다른 구현을 넣습니다. Git이 잡는 텍스트 충돌인지 의미 충돌인지 구분해야 합니다.
- 카테고리: `behavior`
- 근거: `src/core/lombok/Builder.java`, `@Retention(SOURCE)`
- 권장 조치: causal witness가 가리키는 경로를 대상으로 교차 테스트를 추가하고 담당자 확인을 받으세요.

## Git text coordination 7건

| Repository | PR pair | 충돌 파일 |
|---|---|---|
| undertow | [#1509](https://github.com/undertow-io/undertow/pull/1509) × [#1602](https://github.com/undertow-io/undertow/pull/1602) | `servlet/src/main/java/io/undertow/servlet/spec/ServletInputStreamImpl.java` |
| undertow | [#1934](https://github.com/undertow-io/undertow/pull/1934) × [#1501](https://github.com/undertow-io/undertow/pull/1501) | `core/src/main/resources/META-INF/services/io.undertow.server.handlers.builder.HandlerBuilder` |
| undertow | [#1776](https://github.com/undertow-io/undertow/pull/1776) × [#1509](https://github.com/undertow-io/undertow/pull/1509) | `servlet/src/main/java/io/undertow/servlet/UndertowServletLogger.java` |
| undertow | [#1777](https://github.com/undertow-io/undertow/pull/1777) × [#1776](https://github.com/undertow-io/undertow/pull/1776) | `core/src/main/java/io/undertow/UndertowLogger.java` |
| mockito | [#3742](https://github.com/mockito/mockito/pull/3742) × [#3741](https://github.com/mockito/mockito/pull/3741) | `gradle/libs.versions.toml` |
| lombok | [#3372](https://github.com/projectlombok/lombok/pull/3372) × [#4010](https://github.com/projectlombok/lombok/pull/4010) | `AUTHORS` |
| lombok | [#3876](https://github.com/projectlombok/lombok/pull/3876) × [#3874](https://github.com/projectlombok/lombok/pull/3874) | `src/core/lombok/javac/handlers/HandleBuilder.java` |

이 7건은 Git 이 먼저 막는 기계적 conflict 이며 silent semantic conflict 수에는 포함하지 않는다.

## Git preflight 상태

| Repository | 검사 pair | Clean | Text conflict | Base-conflict pair | 비교 불가 pair | Base-conflict PR 수 | Base 준비 불가 PR 수 |
|---|---:|---:|---:|---:|---:|---:|---:|
| undertow | 618 | 303 | 4 | 311 | 0 | 11 | 0 |
| jackson-databind | 296 | 121 | 0 | 19 | 156 | 3 | 0 |
| mockito | 185 | 51 | 1 | 133 | 0 | 17 | 2 |
| lombok | 570 | 238 | 2 | 330 | 0 | 13 | 0 |
| **합계** | **1,669** | **713** | **7** | **793** | **156** | **44** | **2** |

`Insufficient` 는 semantic conflict 가 아니라, 관련 pair 중 한쪽 PR 이 current base 와 먼저 충돌해 판정을 보류한 수다.

## 해석 경계

- 2026-07-20 실행 시점의 전체 open PR snapshot 이다. 이후 PR 상태나 head SHA 가 바뀌면 결과도 바뀐다.
- deterministic 분석은 2,773 pair 전체에 수행했지만, Git preflight 는 상호작용 신호가 있는 1,669 pair 에만 수행됐다.
- semantic conflict, Git text coordination, current-base conflict 는 서로 다른 gate 다.
- Docker 결합 실행을 하지 않았으므로 confirmed pair regression 은 0건이다.
- **AI second-look 미실행.** AI 판정 항목은 정의상 0이며, 다른 팀원 리포트의 AI 산출물과 직접 비교 대상이 아니다.
