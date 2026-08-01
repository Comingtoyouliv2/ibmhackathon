import { AlertTriangle, Database, FlaskConical } from "lucide-react";

import { HypothesisCard } from "@/components/hypothesis/hypothesis-card";
import { LabConsole } from "@/components/hypothesis/lab-console";
import results from "@/lib/hypothesis/results.json";
import type { HypothesisResults } from "@/lib/hypothesis/types";

export const metadata = {
  title: "Hypothesis Lab — Felix Choi",
  description:
    "Trader folklore, tested mechanically on 3 years of Hyperliquid BTC data, cross-verified by Claude and OpenAI.",
};

const data = results as unknown as HypothesisResults;

const CATEGORY_LABEL: Record<string, string> = {
  macro: "매크로 이벤트",
  price: "가격 패턴",
  seasonality: "시즌성",
};

export default function HypothesisLabPage() {
  const groups = ["macro", "price", "seasonality"] as const;
  return (
    <div className="container py-10">
      <div className="flex items-center gap-2 text-primary">
        <FlaskConical className="h-4 w-4" />
        <span className="text-2xs font-semibold uppercase tracking-widest">Projects / Hypothesis Lab</span>
      </div>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">시장 가설 테스터</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        궁금한 시장 가설을 채팅처럼 물어보세요. Claude가 질문을 분석 스펙으로 바꾸고, Python(pandas)이 3년치
        Hyperliquid 데이터(230개 코인)에서 확률을 계산하고,{" "}
        <span className="text-foreground">Claude와 OpenAI가 같은 통계를 독립적으로 해석</span>해 서로의 판정을
        교차검증합니다 — 숫자는 항상 코드가 만들고, AI는 해석만 합니다.
      </p>

      <LabConsole />

      {data.dataset.sample ? (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          현재 표시 중인 수치는 파이프라인 검증용 샘플 데이터입니다. 실데이터 분석으로 곧 교체됩니다.
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Database className="h-3 w-3" />
          Hyperliquid {data.dataset.coin} · {data.dataset.start} ~ {data.dataset.end} (
          {data.dataset.days.toLocaleString()}일, {data.dataset.nativeInterval} 봉)
        </span>
        <span className="font-mono">
          기저 일간 상승확률 {(data.baseline.upDayProb * 100).toFixed(1)}% · 일 변동성 {data.baseline.dailyVolPct}%
        </span>
        <span>분석 생성 {data.generatedAt.slice(0, 10)}</span>
      </div>

      <h2 className="mt-10 text-lg font-semibold tracking-tight">미리 검증된 가설</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        대표적인 트레이더 통념 8가지를 같은 파이프라인으로 미리 검증해 둔 결과입니다.
      </p>

      {groups.map((g) => {
        const items = data.hypotheses.filter((h) => h.category === g);
        if (!items.length) return null;
        return (
          <section key={g} className="mt-8">
            <h2 className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
              {CATEGORY_LABEL[g]}
            </h2>
            <div className="mt-3 space-y-4">
              {items.map((h) => (
                <HypothesisCard key={h.id} h={h} />
              ))}
            </div>
          </section>
        );
      })}

      <p className="mt-10 border-t border-border/60 pt-4 text-2xs leading-relaxed text-muted-foreground">
        방법론: 통계는 이항검정(방향성 가설) 또는 부트스트랩 20,000회(평균 비교)로 계산. p&lt;0.05 지지, p&lt;0.10 약한
        지지, 표본 5건 미만은 판단 불가로 처리. 과거 성과는 미래를 보장하지 않으며, 이 페이지는 투자 조언이 아닙니다.
        재현 코드: <span className="font-mono">scripts/hypothesis/</span>
      </p>
    </div>
  );
}
