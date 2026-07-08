한 줄 요약: 여러 PR이 합쳐졌을 때, 각 PR이 하려는 것을 AI가 먼저 추출해, 그것들이 서로 어긋나는 지점을 병합 전에 알려주고, 시각화하여 어떤 것을 고쳐야 할지 보여준다.

---

## 1. Problem statement

코딩 에이전트로 코딩을 함에 따라, PR 생성 속도가 증가하는 것을 탐지할 수 있었다. 예를 들어, 대표적인 오픈소스인 openclaw 는 현재, 약 2800 개의 PR 이 열려 있으며, 지금까지 약 54K 개의 PR 이 Closed 되어 있음을 확인할 수 있다.

현재 대부분의 툴들은 [각 PR] <-> [Main branch] 를 기준으로 검수하는 방법을 사용하고 있다. 각 PR 이 개별적으로 컴파일되고, 테스트를 통과하고, git merge, merge queue 충돌이 없으면 통과하는 형식이다.


이 방식에는 사각지대가 있다. 서로 독립적인 PR 두 개가, git상 충돌이 없고 각자 CI도 통과하는데, 합쳐지면 한쪽의 가정을 다른 쪽이 깨뜨려 로직이 깨지는 경우가 있다. 이 결함은 어느 한 PR에 있는 게 아니라 "합쳐진 상태"에만 존재하기 때문에, 개별 PR 검수를 통해서는 판별하기 어렵다.

예를 들어, 가상화폐에서는 이런 해킹 사건이 있었다. 
Contract A, Contract B 가 각각 기능적 혹은 취약점 방면에서 문제가 없었지만, Contract A 와 B 의 함수가 합쳐지면서 의도하지 않던, 기능을 작동하게 만들어, 총 30만달러가 해킹 당한 경우가 있었다. (Contract = function)


우리가 푸는 것: 이런 PR 간 충돌을 병합 전에 감지하고 이유를 설명하고 시각화를 하여, 많은 PR 을 찾아보는 것이 아닌, 병목이 생긱는 지점만 쉽게 볼 수 있게 하여, 쉽게 개발자들이 고칠 수 있게 도와 준다. (프로덕트 만들면서 괜찮다 싶으면 고치는 것 까지 자동화)

---

## 2. Motivation (2.2 만 포함되어도 괜찮을 것 같습니다)

### 2.1 이건 이미 이름 있는 난제다 (학술적 뒷받침)
우리가 노리는 현상의 정식 명칭은 **higher-order merge conflict / semantic merge conflict**다. 정의가 표적과 일치한다: 서로 다른 부분의 변경들이 의도치 않게 상호작용하며 생기고, 각 개발 브랜치를 아무리 철저히 테스트해도 못 잡을 수 있으며, 컴파일과 테스트가 대개 이를 포착하지 못한다.

빈도 근거:
- Microsoft Edge 개발 과정에서 semantic merge conflict가 매일 발생한다고 보고된다.
- SAP HANA(대형 C++ 상용 제품)에서 22개월간 빌드 실패를 일으킨 higher-order conflict를 연구 대상으로 삼았다.
- 오픈소스 143개 프로젝트 분석: 병합의 약 1/5이 충돌을 일으켰고, 그중 75%는 개발자가 프로그램 로직을 따져야 해결됐으며, 충돌 지점 코드는 버그를 가질 확률이 2배(수동 개입 시 26배) 높았다.
- 테스트로만 드러나는 동적 의미론적 충돌 비율은 연구에 따라 3~35% 범위.

### 2.2 AI PR 폭증으로 통증이 이제 커졌다 & Evidence 
독립 PR 간 충돌은 동시에 열린 PR이 많을 때만 자주 생긴다. 사람이 하나씩 올리던 시절엔 드물었지만, AI 에이전트가 PR을 대량 생산하면서 통증이 급증하고 있다. 실제로 오픈소스 메인테이너들이 AI 생성 PR 물량에 압도되고 있다(Jazzband 폐쇄, tldraw 외부 PR 차단 등).

** Openclaw PR: 101471, 95272
101471: skip preemptive overflow check when context engine owns compaction
95272: feat(agent): add session self-compaction action

대화 내용이 많아졌을때, compaction 에 관한 권한 위임을 어떻게 할 것인가
101471 - context engine 에게 compaction 권한 제공
95272 - Agent (runner) 에게 compaction 권한 제공

각각의 코드를 봤을때는 문제가 없음 & 또한 논리적 

발생할 수 있는 문제
1. 둘 다 compaction 을 진행 -> compact 된 대화 내용 불일치 가능성 제시, 
2. 권한 infinite loop 발생 -> agent 가 compact 요청 -> runner : context engine 으로 권한 이해 -> context engine: compaction 실행 요청 한 적 없음 -> compaction 이 안 됌 -> 근데 agent 를 요청했으므로 되었다고 결론지어 아무일도 안 함 -> 대화 내용이 계속 증폭되므로 API 한도에서 break 
=> 둘 다 merge 된 경우 PR #101471 이 self preemptive check 를 꺼서, 오류를 탐지하지 못하고, 다른 식의 에러로 직면 

또한 #95272 본문을 참고하면,
This intentionally does not introduce a broad continuation framework or a separate compaction scheduler. Related broad work exists in #85651, but this PR is the small current-session self-compact action for #6757. 

연관되는 작업들이 꾸준하게 존재하기에, connection 을 보여줄 수 있는 툴이 필요하다. 


### 2.3 왜 지금까지 아무도 안 했나
이 문제를 풀려면 diff의 semantic 을 이해하고 "의도 했던 기능이 서로 깨지나를 찾아야 하는데, 이건 동적/정적 분석으로 안 되고 전체 레포 맥락을 이해하는 LLM이 있어야 비로소 가능해졌다. 기존 도구들이 설계되던 시점엔 이 추론이 신뢰성 있게 되지 않았다. 문제가 점점 발생하고 있으며 (AI PR 폭증)과 그것을 풀 수단이 새로 생긴 것(레포 맥락 LLM)이 지금의 엣지를 만들어주고 있다.

### 2.4 임팩트
개발자 리뷰 병목 완화, 온보딩(PR 간 관계로 빠른 맥락 파악), 오픈소스 기여·유지보수 생산성 향상(특히 AI PR이 넘치는 레포).

### 2.5 목표
실제 opensource 를 탐지해서, 기능적 결함을 찾아내서 데모잉. 

---

## 3. How to solve

### 3.1 Scope (반드시 지킬 것)
- 겹칠 수 있는 기능: 스택형 PR 관리·merge queue·자동 리베이스(Graphite/Aviator/Mergify), git 텍스트 충돌 감지(GitHub), 코드 스타일·보안 라인 리뷰(CodeRabbit 등).
- merge queue 와 차이점: merge queue는 "합쳐서 CI 재실행"으로 main과 발생하는 충돌을 탐지한다. 우리는 그 CI 재실행조차 통과하는(테스트가 커버 못 하는) "기능의 의도 레벨에서의 탐지와, 아직 병합 전인 열린 PR 간 충돌을 노린다. 
Merge queue 에서 +@ 를 해주는 것



### 3.2 Pipeline (경우의 수 커팅)
모든 쌍(n²)을 비교하지 않는다. 모든 PR 을 pair 로 비교하는 순간, 경우의 수가 압도적으로 증가한다. 

``` 
Filtering Metholody

전체 Open PR
      │ 0단계: 문서·포맷·테스트·의존성 PR 제외 (코드와 직접적으로 관련이 없는 것들)
      ▼
로직 변경 PR 
      │ 1단계: 각 PR → Intent Card (LLM 1회/PR); LLM 이 코드를 보고 각 변동이 뭘 의도하는지 추론
      ▼
의도를 통하여 Bucket sectoring
      │ 2단계: Pruning — LLM 이 추출한 (문장들을 통하여), 코드 끼리 비교하기 보다는, 의도를 파악하여, 기능적으로 │연관이 있는지 여부를 파악해 같이 묶어서 볼 것/안 볼 것을 결정
      ▼
후보 쌍 수십 개  <- 경우의 수 최소화
      │ 3단계: Judgment — 후보에만 LLM 판정 + 이유 (이유·심각도·신뢰도)
      ▼
    시각화
```

### 3.3 시각화

- 일단 염두하고 있는건
1. PR 들끼리의 연관관계를 knowledge graph 처럼 시각화
2. 에러가 발생할 수 있다면, 각 Node 끼리 연결된 edge (선) 이 빨갛게 혹은 어떤 색깔로 표현해 유저가 볼 수 있게 만들기.

근데 더 좋은 아이디어 있으면 언제든지 환영입니당


### 3.4 Bob 활용
- (a) Opus 4.8 (추론 능력이 가장 높음) + 검사 도구로 Bob 사용 + 세션 리포트 export 제출 (필수).

---

## 4. Milestone (Timeline) (2026-07-07 → 2026-07-24); 
개발 속도에 따라 유동적으로 진행할 예정입니다. 더 빨리되면 더 많은 기능을 넣고, 개선하는 쪽으로 진행하면 될 것 같습니다. 
AI 가 얼마나 빠르게 해줄지 감이 안 잡혀서 rough 하게만 적었습니다 

[개발 7/7~7/24]

- 백엔드 (엔진)

1주차  (7/7 ~ 7/11)
파이프라인 Step 0/1/2 & Quality checks
목표 1: 깃헙 API 를 통한 Open PR + Diff 수집이 가능해야 함 e.g. openclaow 에서 PR 50 개 가져와 파일/심볼 목록까지 파싱 
목표 2: 한 PR 을 정해, 함수의 의도를 파악 (차후에 PR 끼리 합쳐서 비교할때, 이 함수의 semantic 을 명확히 가지고 있기 위함) - Intention card 처럼 남겨지는 것이 있어야 함, 그래야 차후에 bucket 에 담아 sorting 하는게 쉬워질 것 같습니다.
목표 3: Bucket Sectoring - intention 들이 기능적, 변수 ..etc 들이 연관되는지 확인

2주차 (7/12 ~ 7/18)
step 2/3 & 시각화
목표 1: Pruning 작업이 실제로 Pair 갯수를 줄여주는지 확인, false negative 와 같은 것들 점검이 필요
목표 2: IBM BOB 을 통해, bucket 안에서 평가작업이 이루어짐(reasoning, severity, 신뢰도 등등...)

3주차 (7/18 ~ 7/24) 
실제 깃헙에 사용하며 테스트 진행 및 필요 기능 수정 
목표 1: opensource 하나를 타깃해, open PR 기준으로 결과가 잘 나오는지 확인
목표 2: Reasoning/Confidence 개선 작업 필요 


- 프론트 (UI/UX 를 고려한 대시보드 디자인) 
** 오픈소스로 다운 받게 만들 것 같습니다. 디자인은 아직 정해진 바가 없고, PR 시각화는 개발과 함께 제가 도맡아 하겠습니다 (최원재). 유저가 쓰기 쉬운 디자인이면 좋을 것 같습니다.

차후에 시각화 기능만 결합될 수 있게 칸 비워주시면 감사드리겠습니다! 

1주차  (7/7 ~ 7/11)
목표 1: 디자인 방향 / 컴포넌트 정리 / 색 등등
목표 2: 더미 데이터를 통한 화면 display 
목표 3: 유저에게 효과적인 디자인은 Deliver 하고 있는가? & 너무 AI 스럽지 않은가? 

2주차 (7/12 ~ 7/18)
목표 1: PR Graph 어떻게 나타낼 것인지 구상

3주차 (7/18 ~ 7/24) 
목표 1: 백엔드/프론트 통합작업 (노드 시각화 부분 & 엔진만 프론트에 연동될 수 있게 준비되면 될 것 같습니다)
목표 2: 데모 영상 준비 및 발표 준비 (문제 pinpoint 및 설득 강화)


- 영상 및 데모 준비 7/25~7/30 

---

## 5. 개발 스텝별 구체화 

# Step 0: 수집/Rule Based 필터링 (코드 검증할 필요가 없는 것들에 대한 배제)

Goal: 한 오픈소스로부터 PR 을 끌어와, 어떤 종류의 PR 들이 있는지 조사하고, 문서·포맷·테스트·의존성 PR 제외 (코드와 직접적으로 관련이 없는 것들)

Prerequisite: 
1) 최대한 많은 PR 들을 끌어와서, 어떤 종류의 PR 들이 존재하는지 알아야 한다. 
2) 거기서 프로그램의 핵심 기능과 관련 없는 PR 을 분류하여, 제거한다; 현재로서는 문서/형식/테스트/Dependency 설치 관련 PR 로 예상

sub-step 1) 오픈소스로부터 PR 수집

필요 도구:
+  Github personal access token
+  GraphQL 로 100개씩  


# Step 1: Intent card 제작, 선별된 것들에 대해 LLM 을 통한, 각 PR 의도 추출 및 diff 들 들고 있는 JSON 형태 제작

Goal: 각 PR 들이 뭘 하려는지 정리

Example
{
  "pr": 101643,
  "summary": "세션 유지보수 경고 dedupe 캐시가 무한히 커지는 걸 LRU 축출로 막는다",
  "behavior_changes": [
    {
      "surface": "SessionCache.set",
      "before": "엔트리를 무제한으로 저장",
      "after": "1000개 초과 시 가장 오래 안 쓴 엔트리부터 삭제"
    }
  ],
  "touched_resources": [
    "state:session.warningDedupeCache",
    "config:SESSION_CACHE_MAX"
  ],
  "assumptions": [
    "캐시 엔트리는 축출돼도 다시 만들 수 있다 (영구 데이터가 아니다)",
    "다른 코드가 '한 번 캐시된 키는 계속 존재한다'에 의존하지 않는다"
  ],
  "domains": ["session-state"],
  "confidence": 0.85
}

## touched_resources, domains 는 데이터를 쌓아서 더 세분화 작업이 필요할 것 같습니다. Openclaw PR 긁어와서 AI 랑 했을때는 저런 분류를 추천해줬는데, 실제는 어떤지 봐야할 것 같습니다

1. summary: 차후에 시각화 했을 때, 대시보드에서 노드에 마우스 올렸을때 보여줄 텍스트; 밑의
2. behavior_changes: 이 PR 이 어디서, 어떻게 변했는지 보여줌. 
3. touched_resources: bucket 에 넣을때의 분류 태그 값. 
state:session.warningDedupeCahche 를 공통으로 가지고 있으면 같은 버킷 -> pair 될 수 있는 후보로 자리매김
3-1) state : 실행 중 메모리의 shared state e.g. state:session.cache, state:compaction.ownership
3-2) config : 설정 키, 환경 변수, flag e.g. config:SESSION_CACHE_MAX
3-3) api : 노출된 function/endpoint e.g. api:sendMessage(), api:/v1/sessions
3-4) schema : 데이터의 형태, struct, DB, schema... e.g. schema:TranscriptEntry
3-5) event : 이벤트의 형태 e.g. event:call.speaking, event:message.failed
3-6) file : 파일 포맷, 동일한 경로인지 e.g. file:session.json 

4. assumption: 각 PR 들의 목적 추정 (LLM 추론 능력으로, 각 PR 로부터 추출한 데이터)

5. domains: touched_resources 의 6종 분류 전에 더 넓은 sector 로 묶는 touched_resources 의 전처리 단계, 레포의 merge-risk 라벨과의 교차 검증

# openclaw maintainer 들이 PR 관리 할때 사용하는 태그   
5-1) session-state - 세션 수명 주기, 캐시, 공유 런타임 상태
5-2) compatibility - 기존 동작, 포맷, API 와의 호환
5-3) security-boundary - 인증, 권한, 입력 검증, 신뢰성
5-4) message-delivery - 메시지 전송,재시도,순서, 중복
5-5) gateway - 라우팅 계층 
5-6) other - 위 어디에도 들어가지 않는 것; 위의 태그에 강제로 분류하지 않게 만들기 위함 


6. confidence: 추출 신뢰도 0~1. diff 가 잘렸거나, 맥락 부족이면 낮게 판단. step 3 에서 최종 severity 점수에 반영,
신뢰도 낮은 카드만 골라 재검토


# step 2: Pruning — LLM 이 추출한 Intent card, 기능적으로 연관이 있는지 여부를 파악해 같이 묶어서 볼 것/안 볼 것을 결정 (step1 에서 정한 것(touched_resources) 들을 통해, bucketing)


1. Step 1 에서 정의 내린 것들을 같은 touched_resources sector 안으로 몰아넣기

e.g.
state:compaction.ownsership -> #101471, #95272
api:sendMessaage() -> #100388, #101644
config:zod-schema -> PR 69 개 

2. 각 PR 별로 유사도 혹은 correlation 수치화 -> 그래도 bucket 안에 너무 많은 PR 들이 존재해, case explosion 문제 발생 가능 (step 0 & step 1 해보고, 경우의 수 vs PR 오류 갯수 최적화를 찾아보겠습니다)

지금 떠오르는 해결책
1) summary 를 통해, 비슷한 이야기를 하는 문장인지 비교하기 
2) summary + assumption 을 vectorDB 로 변환해, runtime 줄여보기 (실제 해봐야지 판단 가능할 것 같습니다)



# step 3: Judgment — 후보에만 LLM 판정 + 이유 (이유·심각도·신뢰도) 

Goal: Bucket 에서 존재하는 group 들을 pair 로 만들어, 오류가 발생할 수 있는 것들을 분류해준다. 

1. 관계 유형 (enum)
1-1) semantic_conflict 
      + 충돌인 경우 severity, edge 빨간색으로 표현 등 ... 표시 
1-2) duplicate
1-3) supersedes
1-4) depends_on
1-5) complements
1-6) unrelated 



# step 4: Visualization 

- Rough Design 으로 screenshot 첨부해놨습니다 
      - 노란색: LLM 이 충돌이다, 아니다를 홗긴할 수 없는 것
      - 빨간색: semantic conflict 확실 및 취약점 발생 가능 
      
- 추가 수정이 있을 예정입니다 







