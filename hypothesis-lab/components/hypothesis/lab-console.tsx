"use client";

import { useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, Send, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Hypothesis } from "@/lib/hypothesis/types";
import type { LabResponse } from "@/lib/lab/shared";
import { HypothesisCard } from "./hypothesis-card";

const EXAMPLES = [
  "ETH는 펀딩비 마이너스면 다음날 반등해?",
  "SOL 하루 -8% 급락하면 3일 안에 회복돼?",
  "FED가 금리 동결하면 비트코인은 조용해?",
  "DOGE는 주말에 강해?",
  "BTC OI가 하루 10% 급증하면 곧 떨어져?",
];

const STAGES = ["질문 해석 중 (Claude)", "데이터 계산 중 (Python·pandas)", "AI 교차검증 중 (Claude + OpenAI)"];

/** Adapt a live API response to the precomputed-card shape so we reuse the same UI. */
function toHypothesis(r: LabResponse): Hypothesis {
  const result = r.result!;
  return {
    id: `live-${Date.now()}`,
    question: r.question,
    questionEn: r.spec.interpretation ?? "",
    category: "price",
    method: `${r.spec.interpretation ?? ""} — ${result.meta.coin}, ${result.meta.start} ~ ${result.meta.end}, ${result.meta.horizonDays}일 뒤 ${result.meta.direction === "up" ? "상승" : "하락"} 여부 측정. 이항검정 vs 무조건부 확률.`,
    stats: result.stats,
    cases: result.cases,
    chart: result.chart as Hypothesis["chart"],
    ai: r.ai,
  };
}

export function LabConsole() {
  const [question, setQuestion] = useState("");
  const [stage, setStage] = useState(-1);
  const [results, setResults] = useState<{ key: number; h: Hypothesis }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [unlimited, setUnlimited] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch("/api/lab/auth")
      .then((r) => r.json())
      .then((d) => setUnlimited(Boolean(d.unlimited)))
      .catch(() => {});
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const busy = stage >= 0;

  async function submit(q?: string) {
    const text = (q ?? question).trim();
    if (!text || busy) return;
    setNotice(null);
    setStage(0);
    // staged spinner: advance while waiting (visual only)
    timer.current = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 5000);
    try {
      const res = await fetch("/api/lab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      const data = (await res.json()) as LabResponse & { message?: string };
      if (data.quota) {
        setUnlimited(data.quota.unlimited);
        setRemaining(data.quota.unlimited ? null : data.quota.remaining);
      }
      if (!res.ok || data.error || !data.result) {
        setNotice(data.message ?? "분석에 실패했어요. 잠시 후 다시 시도해 주세요.");
      } else {
        setResults((prev) => [{ key: Date.now(), h: toHypothesis(data) }, ...prev].slice(0, 10));
        setQuestion("");
      }
    } catch {
      setNotice("네트워크 오류가 났어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      if (timer.current) clearInterval(timer.current);
      setStage(-1);
    }
  }

  async function submitCode() {
    const res = await fetch("/api/lab/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (data.ok) {
      setUnlimited(true);
      setShowCode(false);
      setNotice(null);
    } else {
      setNotice(data.message ?? "코드가 올바르지 않아요.");
    }
  }

  return (
    <section className="mt-6">
      <Card className="border-primary/25 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-primary">
            <Sparkles className="h-4 w-4" />
            <span className="text-sm font-semibold">직접 물어보기</span>
          </div>
          <div className="flex items-center gap-2 text-2xs text-muted-foreground">
            {unlimited ? (
              <span className="text-bull">승인됨 · 무제한</span>
            ) : (
              <>
                {remaining !== null ? <span>오늘 남은 횟수 {Math.max(remaining, 0)}회</span> : <span>게스트 하루 3회</span>}
                <button
                  type="button"
                  onClick={() => setShowCode((v) => !v)}
                  className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 transition-colors hover:text-foreground"
                >
                  <KeyRound className="h-3 w-3" /> 접근 코드
                </button>
              </>
            )}
          </div>
        </div>

        {showCode ? (
          <div className="mt-3 flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitCode()}
              placeholder="접근 코드 입력"
              className="h-9 flex-1 rounded-md border border-border bg-background px-3 font-mono text-sm outline-none focus:border-primary/50"
            />
            <Button size="sm" onClick={submitCode}>
              확인
            </Button>
          </div>
        ) : null}

        <div className="mt-3 flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            maxLength={300}
            disabled={busy}
            placeholder="예: 이더리움은 3일 연속 떨어지면 다음날 반등해?"
            className="h-11 flex-1 rounded-lg border border-border bg-background px-3.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/50 disabled:opacity-50"
          />
          <Button onClick={() => submit()} disabled={busy || !question.trim()} className="h-11 px-4">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              disabled={busy}
              onClick={() => submit(ex)}
              className="rounded-full border border-border/70 px-2.5 py-1 text-2xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50"
            >
              {ex}
            </button>
          ))}
        </div>

        {busy ? (
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            {STAGES[stage]}
            <span className="text-2xs opacity-60">(최대 30초)</span>
          </div>
        ) : null}

        {notice ? (
          <div className={cn("mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400")}>
            {notice}
          </div>
        ) : null}
      </Card>

      {results.length ? (
        <div className="mt-4 space-y-4">
          {results.map((r) => (
            <HypothesisCard key={r.key} h={r.h} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
