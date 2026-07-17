# Assumption Radar v0.9.0 상태

- 버전: `0.9.0`
- 기준일: 2026-07-16
- 제품 단계: history-backed causal mining foundation
- 핵심 목표: 같은 파일을 만졌다는 상관관계를 실제 fixing-line 계보와 독립 PR 조건으로 대체한다.

## 이번 버전의 결과

새 고정밀 historical discovery 경로를 추가했다.

```text
fixing PR
  → fixing hunk의 이전 source line
  → time-bounded git blame
  → 실제로 그 path를 수정한 PR commit
  → PR reference / 두 번째 line lineage
  → branch ancestry independence gate
  → merge-tree
  → targeted regression tests
```

주요 구현:

- `src/history-lineage.mjs`: fixing-line provenance, diff-tree 검증, ancestry exclusion
- `src/trace-history.mjs`: 저장된 merged PR snapshot과 bare Git cache를 연결하는 CLI
- `npm run trace:history`: lineage candidate와 exclusion artifact 생성
- backport/cherry-pick anchor 제외
- 같은 base branch만 비교
- fix별 후보 상한과 source-surface evidence 추가
- issue 번호와 PR 번호를 Pull Request API로 구별

## pandas 실전 결과

| 단계 | 수 |
|---|---:|
| merged Python PR snapshot | 245 |
| fix anchors | 163 |
| 최초 file-overlap pair candidates | 30 |
| lineage/independence 후보 | 4 |
| diff-tree 검증 후 후보 | 2 |
| executable positive | **0** |
| executable hard negative | **2** |

두 최종 후보는 synthetic clean merge에서 직접 빌드·실행했다.

- `#65603 × #65607`: HDF 회귀 테스트 4개 통과
- `#66055 × #66059`: parser 영향 테스트 179개 통과, expected xfail 13개

따라서 이번 실행은 Python recall/precision을 만들지 않는다. 대신 잘못된 양성 30개를 benchmark에 넣는 것을 막았고, 실제 hard negative 2개를 추가했다.

## 고쳐진 측정 오류

1. 같은 파일은 인과 증거가 아니다.
2. 최근 PR 개수는 요청한 날짜 범위를 보장하지 않는다.
3. GitHub의 `#NNN`은 issue일 수도 PR일 수도 있다.
4. `git blame --since` boundary commit은 line introducer가 아니다.
5. 한 PR이 다른 PR base에 이미 포함되면 독립 semantic-conflict pair가 아니다.

## 현재 성능 해석

- Java frozen 40건의 v0.8 성능은 그대로 유지해야 한다: triage precision 94.4%, recall 85.0%, F1 89.5%.
- Python은 현재 open-PR hard negative 9건과 이번 executable hard negative 2건이 있지만, clean positive가 0이므로 정확도 주장을 할 수 없다.
- v0.9의 개선은 detector 정확도 상승 수치가 아니라 **gold data contamination 방지와 causal candidate precision 개선**이다.

## 다음 단계

1. 같은 lineage 경로를 merge-commit을 보존하는 Python 저장소에 적용한다.
2. Python clean positive가 최소 20개가 될 때까지 repository-level holdout을 유지한다.
3. TypeScript 저장소에도 동일한 campaign을 별도 수행한다.
4. positive admission 후에만 `language × archetype` precision/recall을 계산한다.

## 다국어 merge-history 추가 실행

실제 two-parent merge를 보존하는 저장소를 위한 공통 채굴기를 추가했다.

- `src/merge-history.mjs`: clean recorded merge, fix window, relevant-path blame, parent lineage 분류
- `src/scan-merge-history.mjs`: `npm run scan:merge-history` CLI와 재현 가능한 실행 메타데이터
- GitHub merge commit의 본문에 있는 실제 PR 제목까지 fix anchor 판정에 사용
- `both-parent-lineage`는 실행 검증 후보, `single-parent-lineage`는 A/B/A+B replay 큐로 분리

실전 결과:

| 저장소 | 언어 | 실제 merge | both-parent 후보 | replay 후보 |
|---|---|---:|---:|---:|
| saltstack/salt | Python | 200 | 0 | 초기 실행 후 게이트 설계에 사용 |
| microsoft/vscode | TypeScript | 100 | 0 | 10 |
| kubernetes/kubernetes | Go | 100 | 0 | 3 |

현재까지 새 clean semantic-conflict 양성은 0이다. VS Code replay 1건은 base/A/B 비교 결과 단일 PR bug로 제외했다. 남은 replay 사례도 `pass(A) / pass(B) / fail(A+B) / pass(fixed)`를 만족하기 전에는 양성이나 recall 계산에 사용하지 않는다.

## Counterfactual 자동 필터

수동으로 모든 replay 후보를 읽는 대신 `src/replay-filter.mjs`와 `npm run filter:replay`를 추가했다.

자동화 범위:

- `(repository, fixing commit, blamed lineage commits)` 기준 가족 중복 제거
- base/A/B/A+B/fixed 결과의 결정적 분류
- GitHub fix PR의 명시적 closing issue 추적
- 이슈 생성일이 두 원인 PR 생성일보다 빠르면 pre-existing 자동 제외
- base 내부 실패의 사용자 도달 가능성이 없으면 자동 제외하지 않고 abstain
- cross-repository issue URL을 원래 repository로 조회해 동번호 public issue 오귀속 방지

실행 결과:

| 입력 | raw | 가족 | 자동 판정 | 수동 큐 |
|---|---:|---:|---:|---:|
| VS Code replay | 10 | 9 | 5 | 4 |
| Kubernetes replay | 3 | 1 | 1 | 0 |

VS Code 자동 판정은 pre-existing 3가족, single-parent 2가족이며 pair-induced positive는 0이다. Kubernetes 3개 raw 후보는 동일 QoS fix/lineage 한 가족으로 접힌 뒤 pre-existing으로 제외됐다.

## 재현

```bash
npm run check
npm test

npm run trace:history -- pandas-dev/pandas \
  --input benchmarks/history-candidates/pandas-dev__pandas-2026-07-16T00-50-55-524Z/merged-prs.jsonl \
  --repo-dir .cache/repos/pandas.git \
  --output benchmarks/history-lineage/pandas-dev__pandas-2026-07-16

GITHUB_TOKEN="$(gh auth token -h github.com)" npm run filter:replay -- \
  benchmarks/merge-history/microsoft__vscode-2026-07-16-replay-queue/review-candidates.jsonl \
  --evidence benchmarks/merge-history/microsoft__vscode-2026-07-16-replay-queue/replay-evidence.jsonl \
  --github \
  --output-dir benchmarks/replay-filter/microsoft__vscode-2026-07-16-github
```
