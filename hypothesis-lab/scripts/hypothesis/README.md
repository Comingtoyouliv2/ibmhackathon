# Hypothesis Lab pipeline

트레이더 통념("FED가 금리 내리면 BTC 오른다" 등)을 3년치 Hyperliquid 데이터로 기계적으로 검증하고,
Claude + OpenAI가 같은 통계를 독립 해석해 교차검증하는 파이프라인.

## 실행

```bash
# 1. 데이터 준비: 프로젝트 루트에 data/ 폴더를 만들고 CSV/Parquet를 넣는다.
#    필요 컬럼(이름 유연): timestamp/time/ts, open/high/low/close(or price), volume, [coin/symbol]

# 2. API 키: .env.local 에
#    ANTHROPIC_API_KEY=...
#    OPENAI_API_KEY=...

# 3. 실행
cd scripts/hypothesis
pip install pandas numpy pyarrow
python run.py                 # 분석 + AI 이중검증 → lib/hypothesis/results.json
python run.py --no-ai         # 통계만 (AI 호출 생략)
python run.py --coin ETH      # 다른 코인
```

결과는 `lib/hypothesis/results.json`에 쓰이고 `/projects/hypothesis-lab` 페이지가 정적 import한다.
재실행 후 커밋/배포하면 사이트에 반영. 방문자에게는 API 비용이 전혀 발생하지 않는다.

## 구조

| 파일 | 역할 |
| --- | --- |
| `events.json` | FOMC 금리결정 캘린더 (2023.2–2026.6, federalreserve.gov 기준) |
| `loader.py` | CSV/Parquet 유연 로더 → 일봉/시간봉 정규화 (UTC) |
| `engine.py` | 가설 정의 + 통계 (이항검정, 부트스트랩 20k) |
| `ai_verify.py` | 동일 통계를 Claude/OpenAI에 독립 전송, 판정 일치 여부 산출 |
| `run.py` | 오케스트레이터 |

## 라이브 모드 (/projects/hypothesis-lab 채팅 콘솔)

정적 8개 가설 외에, 방문자가 자연어로 직접 묻는 라이브 파이프라인이 있다:

```
질문 → Claude(질문→분석스펙 JSON) → api/pyanalyze.py(Vercel Python, pandas 계산)
     → Claude + OpenAI 독립 검증 → 확률·판정·차트
```

- 코드: `app/api/lab/route.ts`(오케스트레이터·인증·쿼터), `lib/lab/`(DSL 타입·LLM 호출), `api/pyanalyze.py`(실행기), `components/hypothesis/lab-console.tsx`(UI)
- 데이터: `api/_data/hl_daily.csv.gz` (230개 코인, 배포 번들). 원본 `data/hl_daily.csv` 갱신 시 gz도 재생성할 것.
- 접근 제어: `LAB_ACCESS_CODES`(쉼표 구분)에 있는 코드 입력자는 무제한, 게스트는 IP·쿠키 기준 하루 3회.

### Vercel 환경변수 (Settings → Environment Variables)

| 변수 | 용도 |
| --- | --- |
| `ANTHROPIC_API_KEY` | 질문 파싱 + Claude 검증 |
| `OPENAI_API_KEY` | OpenAI 검증 |
| `LAB_ACCESS_CODES` | 승인 코드 목록, 예: `felix-vip,friend123` |
| `LAB_COOKIE_SECRET` | 쿠키 서명용 랜덤 문자열 |

로컬에서 라이브 모드 테스트는 `vercel dev` 필요 (Python 함수는 `next dev`로 안 뜸).

## 설계 원칙

- **숫자는 AI가 아니라 pandas가 만든다.** AI는 이미 계산된 통계의 해석만 담당 → hallucination이 수치를 오염시킬 수 없음.
- **두 AI는 서로의 답을 보지 못한다.** 독립 판정 → agree/partial/disagree 로 표시.
- **판정 규칙 고정:** p<0.05 지지, p<0.10 약한 지지, n<5 판단 불가.
- 새 가설 추가: `engine.py`의 `run_all()`에 함수 하나 추가하면 UI에 자동 반영.
