# IBM AI Builders Mock Jury

이 저장소의 Mock 심사는 사용자가 제공한 AI Builders Challenge Wildcard 공고를 기준으로 한다. 공식 배점이 공개되지 않았으므로 `Technical Execution`, `Innovation`, `Feasibility`, `Challenge Fit`, `Real-World Impact`를 각각 20점으로 두는 **내부 가정**이다.

## 역설계한 심사 행동

심사위원은 짧은 시간에 다음 순서로 신뢰를 만든다고 가정한다.

1. 문제와 사용자가 즉시 이해되는가?
2. 데모에서 핵심 흐름이 실제로 동작하는가?
3. IBM Bob이 이름표가 아니라 필요한 일을 수행하는가?
4. 비교 기준과 재현 가능한 기술 증거가 있는가?
5. 실제 업무 결과가 어떻게 좋아지는지 측정했는가?

그래서 점수는 주장보다 증거에 묶인다. 로드맵은 구현 점수가 아니고, synthetic demo는 실제 사용자 효과가 아니며, 일부 테스트 통과는 해당 범위의 `no observed failure`만 뜻한다.

## 스킬

| 스킬 | 역할 |
|---|---|
| `$ibm-hackathon-technical-judge` | 실행 흐름, Bob 통합, 구조, 검증, 보안 |
| `$ibm-hackathon-innovation-judge` | 문제 재정의, 차별화, 기술적 새로움 |
| `$ibm-hackathon-feasibility-judge` | MVP, 배포, 비용, 운영, 도입 가능성 |
| `$ibm-hackathon-challenge-fit-judge` | Future of Work와 실제 팀 workflow 정합성 |
| `$ibm-hackathon-impact-judge` | 사용자 pain, 측정 결과, 실제 검증, ROI |
| `$ibm-hackathon-jury` | 다섯 결과 통합, 검증, 개선 우선순위 |

## Stage/commit마다 실행

현재 index를 심사하려면 먼저 코드만 stage한 뒤:

```bash
cd assumption-radar
npm run judge:collect -- \
  --target staged \
  --output hackathon/judging/evidence/latest.json \
  --verify
```

그다음 Codex에 다음처럼 요청한다.

```text
$ibm-hackathon-jury로 staged snapshot을 채점하고 scorecard를 검증해줘.
```

커밋 자체를 심사하려면:

```bash
npm run judge:collect -- \
  --target commit \
  --commit HEAD \
  --output hackathon/judging/evidence/latest.json \
  --verify
```

`--verify`는 현재 worktree에서 실행된다. staged/commit과 tracked product 파일이 다르면 evidence가 `snapshotMatch: false`로 표시되며, 이 실행 결과는 E2 점수에 사용할 수 없다.

Scorecard JSON을 만든 후:

```bash
npm run judge:validate -- \
  hackathon/judging/scorecards/<snapshot>.json \
  --evidence hackathon/judging/evidence/latest.json \
  --render hackathon/judging/scorecards/<snapshot>.md
```

## 개선 gate

기본 내부 목표는 총점 85점 이상, 각 항목 15점 이상, fatal risk 없음, 재현 가능한 end-to-end demo, 데모에서 보이는 IBM Bob 가치다. 점수가 낮으면 예상 점수 상승폭, 증거 확실성, 구현 비용을 함께 보고 한 번에 가장 레버리지가 큰 변경을 선택한다.

rubric hash가 달라진 scorecard는 연속 점수처럼 비교하지 않는다. 이전 scorecard는 수정하지 않고 새 snapshot으로 다시 다섯 항목을 처음부터 채점한다.

두 snapshot의 점수 변화를 비교하려면:

```bash
npm run judge:compare -- \
  hackathon/judging/scorecards/<before>.json \
  hackathon/judging/scorecards/<after>.json
```

## 자동 pre-commit loop

한 번 설치하면 `git commit` 직전에 staged tree만 대상으로 자동 실행된다.

```bash
cd assumption-radar
npm run judge:hook:install
npm run judge:hook:status
```

실행 흐름:

1. staged tree와 테스트 증거를 고정한다.
2. 기존 구현 대화와 무관한 새 `codex exec --ephemeral` jury agent를 read-only로 실행한다.
3. 85점/항목별 15점/Bob·demo subscore/fatal-risk gate를 확인한다.
4. 미달이면 별도의 ephemeral implementation agent를 임시 worktree에서 실행한다.
5. 허용 경로, symlink, 테스트, 항목별 점수 회귀를 검사한다.
6. 동일 rubric에서 총점이 3점 이상 상승하고 항목별 회귀가 없는 patch만 candidate index에 반영한다.
   탈락한 후보는 폐기하고, 남은 횟수가 있으면 새 구현 agent가 supervisor의 탈락 사유만 받아 다시 시도한다.
7. 통과하면 변경을 stage하고 commit을 계속한다. 최대 3회에도 미달이면 개선분은 stage하되 commit은 중단한다.

두 agent는 session history를 공유하지 않는다. 구현 agent에는 jury의 구조화된 scorecard만 전달한다. 원본 worktree에서 직접 구현하지 않으므로 실패한 후보가 사용자 파일을 오염시키지 않는다.

자동 구현이 수정할 수 있는 범위는 기본적으로 `assumption-radar/src`, `public`, `test`, `docs`, `config`, `demo`와 핵심 설명 문서뿐이다. rubric, hook, scorecard, benchmark/gold, package/lockfile, CI, secret은 차단한다.

운영 명령:

```bash
# 설치 상태와 Codex CLI 확인
npm run judge:loop:check

# 자동 구현 없이 jury 결과만으로 commit 차단
IBM_JURY_AUTOFIX=0 git commit

# 한 번의 commit 시도에서 반복 횟수 조정
IBM_JURY_MAX_ITERATIONS=1 git commit

# hook 제거
npm run judge:hook:uninstall
```

staged 내용과 허용 경로의 worktree 내용이 다르면 자동 구현은 중단된다. 먼저 해당 변경을 stage하거나 별도로 보관해야 한다.

기본 설정은 `.agents/skills/ibm-hackathon-jury/references/automation-config.json`에 있다. 현재 jury는
`gpt-5.6-terra/high`, 구현은 `gpt-5.6-sol/high`이며 각각 10분/15분 timeout이다. 실제 E2E에서는
한 번의 구현·재심사 cycle이 수 분 이상 걸릴 수 있다. 총점 최소 상승폭 3점은 독립 jury 실행 사이의
작은 점수 흔들림을 개선으로 오인하지 않기 위한 보수적 margin이다.
