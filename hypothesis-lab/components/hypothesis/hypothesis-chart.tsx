"use client";

import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { CategoryBar, HypothesisCase } from "@/lib/hypothesis/types";

const BULL = "hsl(165 70% 55%)";
const BEAR = "hsl(350 80% 60%)";
const AXIS = "hsl(218 10% 40%)";

const tooltipStyle = {
  background: "hsl(222 14% 7%)",
  border: "1px solid hsl(222 14% 14%)",
  borderRadius: 8,
  fontSize: 12,
};

/** One bar per historical event — green when the move was up, red when down. */
export function EventBarsChart({ cases, height = 220 }: { cases: HypothesisCase[]; height?: number }) {
  if (!cases.length) {
    return (
      <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height }}>
        표본 없음 — 데이터 기간 내 해당 이벤트가 없습니다
      </div>
    );
  }
  const data = cases.map((c) => ({ ...c, x: c.date.slice(2) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="x"
          stroke={AXIS}
          fontSize={10}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          minTickGap={24}
        />
        <YAxis
          stroke={AXIS}
          fontSize={11}
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={(v) => `${v}%`}
        />
        <ReferenceLine y={0} stroke={AXIS} strokeOpacity={0.4} />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(v: number) => [`${v > 0 ? "+" : ""}${v}%`, "수익률"]}
          labelFormatter={(_, p) => {
            const d = p?.[0]?.payload as HypothesisCase | undefined;
            return d ? `${d.date} · ${d.label}` : "";
          }}
        />
        <Bar dataKey="returnPct" isAnimationActive={false} radius={[2, 2, 0, 0]}>
          {data.map((c) => (
            <Cell key={c.date + c.label} fill={c.returnPct >= 0 ? BULL : BEAR} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Aggregated bars (weekday / month seasonality). */
export function CategoryBarsChart({ data, height = 220 }: { data: CategoryBar[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <XAxis dataKey="label" stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} />
        <YAxis
          stroke={AXIS}
          fontSize={11}
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={(v) => `${v}%`}
        />
        <ReferenceLine y={0} stroke={AXIS} strokeOpacity={0.4} />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(v: number, name) => [`${v > 0 ? "+" : ""}${v}%`, "평균 수익률"]}
          labelFormatter={(l, p) => {
            const d = p?.[0]?.payload as CategoryBar | undefined;
            return d ? `${l} · n=${d.n} · 상승확률 ${(d.upRate * 100).toFixed(0)}%` : String(l);
          }}
        />
        <Bar dataKey="avgReturnPct" isAnimationActive={false} radius={[2, 2, 0, 0]}>
          {data.map((c) => (
            <Cell key={c.label} fill={c.avgReturnPct >= 0 ? BULL : BEAR} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
