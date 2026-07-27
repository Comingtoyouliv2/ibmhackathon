# Assumption Radar live three-repository run — deterministic only

## 실행 조건

| 항목 | 값 |
|---|---|
| 실행 완료 | 2026-07-20 20:28 KST (2026-07-20T11:28:44.112Z) |
| 애플리케이션 | Assumption Radar 1.0.0 |
| AI provider / model | 사용 안 함 (결정적 분석만) |
| 분석 명령 | `npm run scan -- <owner/repo> --limit <N> --preflight` |
| Pair 범위 | 수집 후 stack collapse 를 적용한 모든 open PR 조합 |
| Git 검사 | current base 로 정규화한 git merge-tree preflight |
| Docker Base/A/B/A+B | 실행하지 않음 |

## 전체 요약

| Repository | 요청 PR | 수집 PR | 전체 pair | Semantic conflict | Review | Git coordination | Insufficient | Independent | 소요 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| undertow-io/undertow | 44 | 44 | 946 | 0 | 1 | 4 | 311 | 630 | 74s |
| FasterXML/jackson-databind | 25 | 25 | 300 | 0 | 0 | 0 | 19 | 281 | 35s |
| mockito/mockito | 37 | 37 | 666 | 0 | 0 | 1 | 133 | 532 | 57s |
| projectlombok/lombok | 42 | 42 | 861 | 1 | 1 | 2 | 330 | 527 | 63s |
| **Total** | 148 | 148 | 2773 | 1 | 2 | 7 | 793 | 1970 | |

## Semantic conflict 상세

| Repository | PR pair | 판정 source | 근거 | 권장 조치 |
|---|---|---|---|---|
| undertow | #1455982480 × #1918718476 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| undertow | #3377670755 × #1414695543 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| undertow | #2778366133 × #1455982480 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| undertow | #2795633619 × #2778366133 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| undertow | #4062157458 × #1031503227 | framework | 두 PR이 동일한 base 라인을 제거하고 서로 다른 구현을 넣습니다. Git이 잡는 텍스트 충돌인지 의미 충돌인지 구분해야 합니다. | causal witness가 가리키는 경로를 대상으로 교차 테스트를 추가하고 담당자 확인을 받으세요. |
| mockito | #2875505114 × #2875503889 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| lombok | #4011222369 × #2480978126 | framework | 한 PR은 lombok.Builder binding을 제거하지만 다른 PR은 같은 파일에서 Builder을 새로 사용하며 대체 binding을 제공하지 않습니다. | 두 PR을 같은 integration branch에 합쳐 witness가 가리키는 계약을 먼저 통일하세요. |
| lombok | #1277292207 × #3276789145 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| lombok | #2487180951 × #2480978126 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| lombok | #2480978126 × #1892853852 | framework | 두 PR이 동일한 base 라인을 제거하고 서로 다른 구현을 넣습니다. Git이 잡는 텍스트 충돌인지 의미 충돌인지 구분해야 합니다. | causal witness가 가리키는 경로를 대상으로 교차 테스트를 추가하고 담당자 확인을 받으세요. |

## Preflight 보류 현황

| Repository | Base-conflict PR | Base-unavailable PR | Textual conflict pair |
|---|---|---|---:|
| undertow-io/undertow | #814, #1008, #1282, #1291, #1437, #1470, #1488, #1711, #1772, #1921, #1936 | 없음 | 4 |
| FasterXML/jackson-databind | #3595, #3597, #5850 | 없음 | 0 |
| mockito/mockito | #1901, #2048, #2571, #3028, #3063, #3123, #3154, #3161, #3216, #3278, #3535, #3587, #3593, #3650, #3701, #3781, #3816 | #3501, #3736 | 1 |
| projectlombok/lombok | #1402, #1545, #2522, #2779, #2850, #2878, #3022, #3338, #3589, #3646, #3692, #3816, #4009 | 없음 | 2 |

## 비교 시 해석 경계

- 이 결과는 2026-07-20 live open-PR snapshot 이다. repository / 실행 시각 / PR 목록 / base SHA 가 다르면 raw count 를 정확도 차이로 해석하면 안 된다.
- semantic conflict, Git coordination, insufficient 는 서로 다른 gate 다. 세 수치를 합쳐 하나의 conflict 수로 비교하지 않는다.
- **결정적 분석은 모델과 무관**하므로 다른 팀원 결과와 직접 비교 가능하다. 이번 실행은 AI second-look 을 사용하지 않았다.
- Docker Base/A/B/A+B 검증을 실행하지 않았으므로 confirmed-conflict 는 0 이며, semantic conflict 는 실행 재현 결과가 아니다.
