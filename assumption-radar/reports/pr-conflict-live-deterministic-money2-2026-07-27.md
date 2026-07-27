# Assumption Radar live three-repository run — deterministic only

## 실행 조건

| 항목 | 값 |
|---|---|
| 실행 완료 | 2026-07-27 17:53 KST (2026-07-27T08:53:13.213Z) |
| 애플리케이션 | Assumption Radar 1.0.0 |
| AI provider / model | 사용 안 함 (결정적 분석만) |
| 분석 명령 | `npm run scan -- <owner/repo> --limit <N> --preflight` |
| Pair 범위 | 수집 후 stack collapse 를 적용한 모든 open PR 조합 |
| Git 검사 | current base 로 정규화한 git merge-tree preflight |
| Docker Base/A/B/A+B | 실행하지 않음 |

## 전체 요약

| Repository | 요청 PR | 수집 PR | 전체 pair | Semantic conflict | Review | Git coordination | Insufficient | Independent | 소요 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| apache/fineract | 76 | 74 | 2701 | 8 | 0 | 67 | 638 | 1988 | 377s |
| **Total** | 76 | 74 | 2701 | 8 | 0 | 67 | 638 | 1988 | |

### 수량 차이 (open PR 실시간 변동)

- **apache/fineract**: 요청 76개 → 실행 시점 수집 74개

## Semantic conflict 상세

| Repository | PR pair | 판정 source | 근거 | 권장 조치 |
|---|---|---|---|---|
| fineract | #4020557127 × #3920237108 | framework | 한 PR은 getActivationDate을 getActivatedOnDate로 바꾸지만 다른 PR은 기존 이름을 새 코드에서 참조합니다. | 두 PR을 같은 integration branch에 합쳐 witness가 가리키는 계약을 먼저 통일하세요. |
| fineract | #4102876065 × #4089692366 | framework | 한 PR은 loan을 zeroInterestLoanId로 바꾸지만 다른 PR은 기존 이름을 새 코드에서 참조합니다. | 두 PR을 같은 integration branch에 합쳐 witness가 가리키는 계약을 먼저 통일하세요. |
| fineract | #4102876065 × #4124648432 | framework | 두 PR이 base의 서로 다른 위치에 동일한 선언 identity를 새로 추가합니다. 각 변경은 단독으로 유효하지만 clean merge 결과에는 중복 선언이 남습니다. | 두 PR을 같은 integration branch에 합쳐 witness가 가리키는 계약을 먼저 통일하세요. |
| fineract | #4102876065 × #3976632814 | framework | 한 PR은 schedulerJobHelper을 schedulerHelper로 바꾸지만 다른 PR은 기존 이름을 새 코드에서 참조합니다. | 두 PR을 같은 integration branch에 합쳐 witness가 가리키는 계약을 먼저 통일하세요. |
| fineract | #3920237108 × #3910847748 | framework | 한 PR은 getActivationDate을 getActivatedOnDate로 바꾸지만 다른 PR은 기존 이름을 새 코드에서 참조합니다. | 두 PR을 같은 integration branch에 합쳐 witness가 가리키는 계약을 먼저 통일하세요. |
| fineract | #4102876065 × #4055336929 | framework | 한 PR은 loan을 zeroInterestLoanId로 바꾸지만 다른 PR은 기존 이름을 새 코드에서 참조합니다. | 두 PR을 같은 integration branch에 합쳐 witness가 가리키는 계약을 먼저 통일하세요. |
| fineract | #4102876065 × #3750742426 | framework | 한 PR은 loan을 zeroInterestLoanId로 바꾸지만 다른 PR은 기존 이름을 새 코드에서 참조합니다. | 두 PR을 같은 integration branch에 합쳐 witness가 가리키는 계약을 먼저 통일하세요. |
| fineract | #3919296603 × #3920237108 | framework | 한 PR은 getActivationDate을 getActivatedOnDate로 바꾸지만 다른 PR은 기존 이름을 새 코드에서 참조합니다. | 두 PR을 같은 integration branch에 합쳐 witness가 가리키는 계약을 먼저 통일하세요. |
| fineract | #4006019326 × #4005961483 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4102876065 × #4119182154 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4119182154 × #3908996128 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3760365042 × #3818687021 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3919296603 × #3910847748 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4119182154 × #3760365042 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3910847748 × #3987541917 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3760365042 × #3910847748 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3908996128 × #3987541917 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3964619665 × #3818687021 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3964619665 × #3760365042 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3959480449 × #3956914246 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3760365042 × #3908996128 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4119182154 × #3987541917 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4119182154 × #3910847748 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3964619665 × #4017208971 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4006019326 × #3987541917 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3908996128 × #3910847748 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4005961483 × #3987541917 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3919296603 × #3987541917 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3818687021 × #3987541917 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3760365042 × #4005961483 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3760365042 × #3919296603 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3818687021 × #4005961483 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3760365042 × #4006019326 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3818687021 × #4006019326 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3964619665 × #4131550830 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3818687021 × #3910847748 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4005961483 × #3910847748 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4006019326 × #3910847748 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4074613680 × #3729351450 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3919296603 × #3908996128 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4119182154 × #3919296603 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4020557127 × #3987541917 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4131594939 × #3831028596 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3919296603 × #4005961483 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3818687021 × #3919296603 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3919296603 × #4006019326 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3964619665 × #4035459834 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4089692366 × #4055336929 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3964619665 × #3976632814 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4119182154 × #4020557127 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4020557127 × #3940335769 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3760365042 × #4027412729 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4125254520 × #4109744965 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3818687021 × #4027412729 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4137989183 × #3960614777 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4131550723 × #3964619665 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4089692366 × #4109744965 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4081782784 × #3750742426 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4102876065 × #3964619665 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4125295180 × #3831028596 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3920237108 × #3858776842 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4020557127 × #3956914246 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4119182154 × #4017208971 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4102876065 × #4027412729 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4102876065 × #3818687021 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3964619665 × #3993372805 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3956914246 × #3987541917 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3956914246 × #3940335769 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4131594939 × #4125295180 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4132352196 × #3964619665 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3956914246 × #3920237108 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4005961483 × #3956914246 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #4006019326 × #3956914246 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3919296603 × #3956914246 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |
| fineract | #3956914246 × #3910847748 | git-preflight | 두 PR은 기계적 merge conflict가 있어 silent semantic-conflict 평가 대상에서 제외됩니다. 충돌 해소 시 한쪽의 의도가 유실되지 않도록 관련 테스트를 함께 실행해야 합니다. | 충돌 파일을 함께 검토하고 두 PR의 회귀 테스트를 보존한 integration branch에서 해소하세요. |

## Preflight 보류 현황

| Repository | Base-conflict PR | Base-unavailable PR | Textual conflict pair |
|---|---|---|---:|
| apache/fineract | #5773, #5873, #5886, #5946, #5951, #5967, #6034, #6081, #6136, #6140, #6143 | #6173 | 67 |

## 비교 시 해석 경계

- 이 결과는 2026-07-27 live open-PR snapshot 이다. repository / 실행 시각 / PR 목록 / base SHA 가 다르면 raw count 를 정확도 차이로 해석하면 안 된다.
- semantic conflict, Git coordination, insufficient 는 서로 다른 gate 다. 세 수치를 합쳐 하나의 conflict 수로 비교하지 않는다.
- **결정적 분석은 모델과 무관**하므로 다른 팀원 결과와 직접 비교 가능하다. 이번 실행은 AI second-look 을 사용하지 않았다.
- Docker Base/A/B/A+B 검증을 실행하지 않았으므로 confirmed-conflict 는 0 이며, semantic conflict 는 실행 재현 결과가 아니다.
