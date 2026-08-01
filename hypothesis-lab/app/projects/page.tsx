import Link from "next/link";
import { ArrowRight, FlaskConical } from "lucide-react";

import { Card } from "@/components/ui/card";
import results from "@/lib/hypothesis/results.json";
import type { HypothesisResults } from "@/lib/hypothesis/types";

export const metadata = {
  title: "Projects — Felix Choi",
  description: "Data experiments on 3 years of Hyperliquid market data.",
};

const data = results as unknown as HypothesisResults;

export default function ProjectsPage() {
  return (
    <div className="container py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        트레이딩 데이터로 하는 실험들. 전부 재현 가능한 코드와 원본 데이터 기반.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Link href="/projects/hypothesis-lab" className="group">
          <Card className="h-full p-5 transition-colors hover:border-primary/40 hover:bg-card/80">
            <div className="flex items-center gap-2 text-primary">
              <FlaskConical className="h-4 w-4" />
              <span className="text-2xs font-semibold uppercase tracking-widest">Hypothesis Lab</span>
            </div>
            <h2 className="mt-2 text-lg font-semibold tracking-tight">시장 가설 테스터</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              “이더리움은 3일 연속 떨어지면 반등해?” — 궁금한 가설을 채팅처럼 입력하면 Python이 3년치 Hyperliquid
              데이터(230개 코인)에서 확률을 계산하고, Claude와 OpenAI 두 AI가 같은 통계를 독립 해석해 교차검증합니다.
              숫자는 코드가, 해석은 AI가.
            </p>
            <div className="mt-3 flex items-center gap-1 text-xs text-primary">
              직접 물어보기 · 사전 검증된 가설 {data.hypotheses.length}개
              <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
            </div>
          </Card>
        </Link>
      </div>
    </div>
  );
}
