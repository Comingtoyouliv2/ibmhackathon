"use client";

import { useState } from "react";
import { ChevronDown, FlaskConical, User } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { fmtPct, pnlColor } from "@/lib/format";
import type { Hypothesis } from "@/lib/hypothesis/types";
import { AiCrosscheck } from "./ai-crosscheck";
import { CategoryBarsChart, EventBarsChart } from "./hypothesis-chart";
import { VerdictBadge } from "./verdict-badge";

function Stat({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div>
      <div className="text-2xs font-medium uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-mono text-sm tabular", className)}>{value}</div>
    </div>
  );
}

export function HypothesisCard({ h }: { h: Hypothesis }) {
  const [open, setOpen] = useState(false);
  const s = h.stats;
  const showCases = h.cases.length > 0;

  return (
    <Card className="p-5">
      {/* chat-style question */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <User className="h-3 w-3" />
          </span>
          <div>
            <p className="rounded-2xl rounded-tl-sm bg-muted/60 px-3.5 py-2 text-sm font-medium leading-snug">
              “{h.question}”
            </p>
            <p className="mt-1 pl-1 text-2xs text-muted-foreground">{h.questionEn}</p>
          </div>
        </div>
        <VerdictBadge verdict={s.verdict} className="shrink-0" />
      </div>

      {/* computed stats */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="표본 수" value={s.n} />
        <Stat
          label="적중 확률"
          value={s.hitRate !== null ? fmtPct(s.hitRate * 100, { decimals: 1 }) : "—"}
          className={s.hitRate !== null && s.baselineRate !== null && s.hitRate > s.baselineRate ? "text-bull" : ""}
        />
        <Stat label="기저 확률" value={s.baselineRate !== null ? fmtPct(s.baselineRate * 100, { decimals: 1 }) : "—"} />
        <Stat
          label="평균 수익률"
          value={s.avgReturnPct !== null ? fmtPct(s.avgReturnPct, { showSign: true }) : "—"}
          className={s.avgReturnPct !== null ? pnlColor(s.avgReturnPct) : ""}
        />
        <Stat label="p-value" value={s.pValue.toFixed(3)} className={s.pValue < 0.05 ? "text-bull" : ""} />
      </div>

      {/* chart */}
      <div className="mt-4">
        {h.chart.type === "categoryBars" && h.chart.data ? (
          <CategoryBarsChart data={h.chart.data} />
        ) : (
          <EventBarsChart cases={h.cases} />
        )}
        {h.chart.note ? <p className="mt-1 text-2xs text-muted-foreground">{h.chart.note}</p> : null}
      </div>

      {/* method + cases */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <FlaskConical className="h-3 w-3" />
        검증 방법 {showCases ? "· 사례별 상세" : ""}
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="mt-2 rounded-lg border border-border/60 bg-background/40 p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{h.method}</p>
          {showCases ? (
            <div className="mt-3 max-h-64 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-2xs uppercase tracking-widest text-muted-foreground">
                  <tr>
                    <th className="pb-1.5 pr-3 font-medium">날짜</th>
                    <th className="pb-1.5 pr-3 font-medium">이벤트</th>
                    <th className="pb-1.5 pr-3 text-right font-medium">수익률</th>
                    <th className="pb-1.5 text-right font-medium">가설 적중</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular">
                  {h.cases.map((c) => (
                    <tr key={c.date + c.label} className="border-t border-border/40">
                      <td className="py-1.5 pr-3">{c.date}</td>
                      <td className="py-1.5 pr-3 font-sans text-muted-foreground">{c.label}</td>
                      <td className={cn("py-1.5 pr-3 text-right", pnlColor(c.returnPct))}>
                        {fmtPct(c.returnPct, { showSign: true })}
                      </td>
                      <td className={cn("py-1.5 text-right", c.hit ? "text-bull" : "text-bear")}>
                        {c.hit ? "○" : "✕"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      <AiCrosscheck claude={h.ai.claude} openai={h.ai.openai} agreement={h.ai.agreement} />
    </Card>
  );
}
