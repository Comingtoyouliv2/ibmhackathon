import { Bot, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Agreement, AiOpinion } from "@/lib/hypothesis/types";
import { VerdictBadge } from "./verdict-badge";

const AGREEMENT: Record<Agreement, { label: string; cls: string; Icon: typeof ShieldCheck }> = {
  agree: { label: "두 AI 판정 일치", cls: "text-bull", Icon: ShieldCheck },
  partial: { label: "부분 일치", cls: "text-amber-400", Icon: ShieldQuestion },
  disagree: { label: "판정 불일치 — 주의", cls: "text-bear", Icon: ShieldAlert },
  unverified: { label: "AI 검증 대기 중", cls: "text-muted-foreground", Icon: ShieldQuestion },
};

function OpinionBlock({ name, op }: { name: string; op: AiOpinion | null }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
          <Bot className="h-3 w-3" />
          {name}
          {op ? <span className="font-mono normal-case tracking-normal opacity-60">{op.model}</span> : null}
        </div>
        {op ? <VerdictBadge verdict={op.verdict} /> : null}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {op ? op.commentary_ko : "아직 실행되지 않았습니다."}
      </p>
    </div>
  );
}

/**
 * Double-verification panel: Claude and OpenAI read the same computed stats
 * independently. Agreement is a hallucination cross-check — the AIs never see
 * each other's answers and never produce numbers themselves.
 */
export function AiCrosscheck({
  claude,
  openai,
  agreement,
}: {
  claude: AiOpinion | null;
  openai: AiOpinion | null;
  agreement: Agreement;
}) {
  const a = AGREEMENT[agreement] ?? AGREEMENT.unverified;
  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <div className={cn("flex items-center gap-1.5 text-xs font-semibold", a.cls)}>
        <a.Icon className="h-3.5 w-3.5" />
        AI 교차검증 · {a.label}
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <OpinionBlock name="Claude" op={claude} />
        <OpinionBlock name="OpenAI" op={openai} />
      </div>
    </div>
  );
}
