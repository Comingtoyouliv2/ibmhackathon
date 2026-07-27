# Assumption Radar live three-repository run — deterministic only

## 실행 조건

| 항목 | 값 |
|---|---|
| 실행 완료 | 2026-07-27 17:45 KST (2026-07-27T08:45:10.466Z) |
| 애플리케이션 | Assumption Radar 1.0.0 |
| AI provider / model | 사용 안 함 (결정적 분석만) |
| 분석 명령 | `npm run scan -- <owner/repo> --limit <N> --preflight` |
| Pair 범위 | 수집 후 stack collapse 를 적용한 모든 open PR 조합 |
| Git 검사 | current base 로 정규화한 git merge-tree preflight |
| Docker Base/A/B/A+B | 실행하지 않음 |

## 전체 요약

| Repository | 요청 PR | 수집 PR | 전체 pair | Semantic conflict | Review | Git coordination | Insufficient | Independent | 소요 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| killbill/killbill | 23 | 22 | 231 | 1 | 0 | 1 | 25 | 204 | 49s |
| formancehq/ledger | 20 | 20 | 190 | 0 | 0 | 0 | 38 | 152 | 41s |
| **Total** | 43 | 42 | 421 | 1 | 0 | 1 | 63 | 356 | |

### 수량 차이 (open PR 실시간 변동)

- **killbill/killbill**: 요청 23개 → 실행 시점 수집 22개

## Semantic conflict 상세

| Repository | PR pair | 판정 source | 근거 | 권장 조치 |
|---|---|---|---|---|
| killbill | #1566516722 × #1566512819 | framework | 두 PR이 base의 서로 다른 위치에 동일한 선언 identity를 새로 추가합니다. 각 변경은 단독으로 유효하지만 clean merge 결과에는 중복 선언이 남습니다. | 두 PR을 같은 integration branch에 합쳐 witness가 가리키는 계약을 먼저 통일하세요. |
| killbill | #3865459868 × #3880808759 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |

## Preflight 보류 현황

| Repository | Base-conflict PR | Base-unavailable PR | Textual conflict pair |
|---|---|---|---:|
| killbill/killbill | #1597, #1819, #2183, #2274 | 없음 | 1 |
| formancehq/ledger | #1394, #1427, #1469, #1494, #1590, #1597 | 없음 | 0 |

## 비교 시 해석 경계

- 이 결과는 2026-07-27 live open-PR snapshot 이다. repository / 실행 시각 / PR 목록 / base SHA 가 다르면 raw count 를 정확도 차이로 해석하면 안 된다.
- semantic conflict, Git coordination, insufficient 는 서로 다른 gate 다. 세 수치를 합쳐 하나의 conflict 수로 비교하지 않는다.
- **결정적 분석은 모델과 무관**하므로 다른 팀원 결과와 직접 비교 가능하다. 이번 실행은 AI second-look 을 사용하지 않았다.
- Docker Base/A/B/A+B 검증을 실행하지 않았으므로 confirmed-conflict 는 0 이며, semantic conflict 는 실행 재현 결과가 아니다.
