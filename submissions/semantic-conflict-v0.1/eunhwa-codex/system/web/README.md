# Contract Radar

개별적으로 base에 병합 가능한 열린 PR을 둘씩 합쳤을 때 발생하는 Git 텍스트 충돌과 semantic 계약 충돌을 찾는 앱이다.

## 현재 동작

- GitHub의 전체 open PR을 페이지네이션해 수집
- CI 성공·실패·진행·미등록과 무관하게 mergeable PR을 Git pair merge 검사
- CI 성공 + mergeable PR만 semantic 계약 분석
- add/modify/delete/rename의 이전·새 경로와 file↔directory prefix를 역색인해 Git 후보를 만들고 실제 `git merge-tree` 실행
- 서로 다른 시점의 synthetic merge ref도 현재 동일 base에 PR delta를 재생한 뒤 병합
- pair merge가 실패하면 `text_conflict`로 즉시 보고
- pair merge가 성공한 쌍만 semantic/build/test 검증 대상으로 전달
- qualified API symbol, 함수 인자 범위, config key, event channel 추출
- 강한 정적 모순은 `semantic_conflict`로 확정
- 동적 계약 또는 약한 심볼 일치는 `needs_verification`으로 분리
- CI 성공·text-clean 후보의 intent/ordering/ownership/lifecycle 위험을 strict-schema LLM으로 판정
- 양쪽 PR의 실제 인용 근거와 역순 2차 판정이 모두 통과한 결과만 `llm_conflict`로 표시
- text-clean 위험 쌍은 격리 컨테이너에서 PR A, PR B, combined tree를 같은 명령으로 차분 실행
- 후보/충돌/검증대기 edge를 그래프로 표시
- 정확한 계약 후보와 별도로 same file/declaration, bounded subtree identifier, 희귀 literal을 합집합한 recall-oriented 의미 후보를 보존
- 그래프 노드 선택 시 PR의 계약·가정·이웃 관계를, edge 선택 시 후보 생성 이유와 최종 판정 근거를 분리 표시

## 실행

```bash
npm install
npm test
npm run dev
```

전체 저장소 스캔에는 GitHub token이 필요하다.

```bash
GITHUB_TOKEN=... npm run scan -- openclaw/openclaw microsoft/vscode oven-sh/bun
npm run rejudge -- artifacts/oss-scan-YYYY-MM-DD.json
npm run verify:pairs -- artifacts/oss-scan-YYYY-MM-DD.json
COMBINED_PAIR=123:456 npm run verify:combined -- artifacts/oss-scan-YYYY-MM-DD.json
OPENAI_API_KEY=... GITHUB_TOKEN=... npm run judge:llm -- artifacts/oss-scan-YYYY-MM-DD.json

# OpenAI quota가 없으면 같은 판정 계약으로 Gemini 사용
LLM_PROVIDER=gemini GEMINI_API_KEY=... GITHUB_TOKEN=... npm run judge:llm -- artifacts/oss-scan-YYYY-MM-DD.json
```

`verify:pairs`는 CI 상태와 무관하게 non-draft PR의 GitHub synthetic merge ref를 확인한다. ref가 없거나 head가 바뀐 PR은 제외한다. 변경 delta는 `synthetic base → synthetic merge result`에서 추출해 하나의 현재 base에 재생한다. `base → PR head`는 오래된 branch가 놓친 upstream 변경까지 PR 변경으로 오인하므로 사용하지 않는다. 재생된 두 commit에 `git merge-tree`를 수행한다. CI 실패 PR은 Git 텍스트 충돌 판정에는 포함하지만, 단독 실패와 pair 영향이 섞이므로 semantic 확정에서는 제외한다.

`verify:combined`는 저장소별 실행 profile(`config/combined-verification.json`)이 있는 위험 쌍을 대상으로 한다. 각 synthetic base에서 분리한 PR delta를 현재 동일 base에 재생한다. 각 PR 단독 tree와 combined tree를 네트워크가 차단된 일회용 Docker 컨테이너에서 같은 명령으로 실행한다. A/B 단독은 통과하고 combined만 같은 실패로 2회 재현되어야 `combined_conflict`, 셋 다 통과하면 `combined_clean`, 단독 실패·timeout·불일치는 `combined_inconclusive`다. 의존성 fetch는 upstream base에서만 수행하고 PR 실행에는 credential이나 호스트 네트워크를 제공하지 않는다.

`judge:llm`은 CI 성공·text-clean 후보만 처리한다. PR 설명과 관련 patch는 명령이 아닌 untrusted evidence로 취급한다. `conflict`에는 양쪽 PR에서 검증 가능한 직접 인용, counterevidence, 재현 절차가 필요하다. 첫 판정과 PR 순서를 뒤집은 확인 판정의 family가 일치하지 않으면 `llm_uncertain`으로 내린다. 기본 공급자는 OpenAI, 기본 모델은 `gpt-5.6-luna`다. `LLM_PROVIDER=gemini`이면 기본 `gemini-3.5-flash`를 사용한다. `OPENAI_MODEL`, `GEMINI_MODEL`, `GEMINI_MIN_INTERVAL_MS`로 모델과 rate-limit 간격을 바꿀 수 있다. 공급자를 바꾸면서 기존 체크포인트를 이어갈 때만 `LLM_KEEP_PROGRESS=1`을 사용한다.

MergeDataset 평가:

```bash
npm run evaluate:mergedataset -- /Users/eunhwa/Downloads/mergedataset_pairs.jsonl
```

## 검증

```bash
npm test
npm run lint
npm run build
```

테스트에는 필수 양성/음성 acceptance case와 symbol collision, optional parameter, JavaScript runtime uncertainty, Python import, config/event 검증대기, rename 및 file↔directory Git 후보, cross-file 의미 후보 회귀가 포함된다.

2026-07-15 평가에서는 MergeDataset의 text-clean semantic conflict 10/10을 후보로 보존했다. 후보 단계는 recall 우선이라 precision 62.5%, recall 100%다. 이어서 패치의 같은 상태 쓰기, write→read 흐름, 컬렉션 크기 변화, 인접 control-flow 변화를 검사하는 semantic triage를 적용했다. 현재 16개 Git-clean benchmark에서는 TP 10, FP 0, FN 0이지만 표본이 작으므로 일반 OSS 전체 정확도로 해석하지 않는다. 결과는 `artifacts/mergedataset-effects.{json,md}`에 기록한다.
