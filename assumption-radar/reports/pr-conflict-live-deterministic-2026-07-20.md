# Assumption Radar live three-repository run — deterministic only

## 실행 조건

| 항목 | 값 |
|---|---|
| 실행 완료 | 2026-07-20 20:03 KST (2026-07-20T11:03:27.171Z) |
| 애플리케이션 | Assumption Radar 1.0.0 |
| AI provider / model | 사용 안 함 (결정적 분석만) |
| 분석 명령 | `npm run scan -- <owner/repo> --limit <N> --preflight` |
| Pair 범위 | 수집 후 stack collapse 를 적용한 모든 open PR 조합 |
| Git 검사 | current base 로 정규화한 git merge-tree preflight |
| Docker Base/A/B/A+B | 실행하지 않음 |

## 전체 요약

| Repository | 요청 PR | 수집 PR | 전체 pair | Semantic conflict | Review | Git coordination | Insufficient | Independent | 소요 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| spring-projects/spring-boot | 27 | 27 | 351 | 0 | 0 | 0 | 21 | 330 | 54s |
| apache/zeppelin | 62 | 62 | 1891 | 0 | 0 | 6 | 110 | 1775 | 108s |
| opensearch-project/opensearch-java | 22 | 21 | 210 | 0 | 0 | 23 | 78 | 109 | 49s |
| **Total** | 111 | 110 | 2452 | 0 | 0 | 29 | 209 | 2214 | |

### 수량 차이 (open PR 실시간 변동)

- **opensearch-project/opensearch-java**: 요청 22개 → 실행 시점 수집 21개

## Semantic conflict 상세

| Repository | PR pair | 판정 source | 근거 | 권장 조치 |
|---|---|---|---|---|
| zeppelin | #4003451104 × #3903162430 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| zeppelin | #3638224877 × #3903162430 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| zeppelin | #4003451104 × #3638224877 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| zeppelin | #4041517683 × #4003451104 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| zeppelin | #4041517683 × #3903162430 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| zeppelin | #4041517683 × #3638224877 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3992977929 × #3992965109 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3993105327 × #3993109162 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3993079953 × #3992977929 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3992965109 × #3993109162 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3993105327 × #3993079953 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3993105327 × #3992965109 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3993079953 × #3993109162 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3993079953 × #3992965109 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3992977929 × #3993109162 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3993105327 × #3992977929 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3992965109 × #3953607876 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3992977929 × #3953607876 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3993105327 × #3953607876 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3993079953 × #3953607876 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3993109162 × #3953607876 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3282529245 × #2456635086 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3966361100 × #3953607876 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3966361100 × #3992965109 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3966361100 × #3992977929 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3966361100 × #3993109162 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3966361100 × #3993105327 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #3966361100 × #3993079953 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| opensearch-java | #4062583734 × #3966361100 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |

## Preflight 보류 현황

| Repository | Base-conflict PR | Base-unavailable PR | Textual conflict pair |
|---|---|---|---:|
| spring-projects/spring-boot | #49793, #50280 | #50489, #50876, #50968 | 0 |
| apache/zeppelin | #4808, #4813, #4864, #4998, #5010, #5012, #5032, #5060, #5082, #5085, #5125, #5134, #5162, #5191, #5220, #5225 | #4868, #4886, #4930, #5008, #5236, #5238, #5242, #5247, #5324 | 6 |
| opensearch-project/opensearch-java | #788, #882, #985, #1574, #1633 | #2042, #2063 | 23 |

## 비교 시 해석 경계

- 이 결과는 2026-07-20 live open-PR snapshot 이다. repository / 실행 시각 / PR 목록 / base SHA 가 다르면 raw count 를 정확도 차이로 해석하면 안 된다.
- semantic conflict, Git coordination, insufficient 는 서로 다른 gate 다. 세 수치를 합쳐 하나의 conflict 수로 비교하지 않는다.
- **결정적 분석은 모델과 무관**하므로 다른 팀원 결과와 직접 비교 가능하다. 이번 실행은 AI second-look 을 사용하지 않았다.
- Docker Base/A/B/A+B 검증을 실행하지 않았으므로 confirmed-conflict 는 0 이며, semantic conflict 는 실행 재현 결과가 아니다.
