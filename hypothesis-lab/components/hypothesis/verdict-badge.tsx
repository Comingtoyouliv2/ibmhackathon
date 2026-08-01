import { cn } from "@/lib/utils";
import type { Verdict } from "@/lib/hypothesis/types";

const CONFIG: Record<Verdict, { label: string; cls: string }> = {
  supported: { label: "가설 지지", cls: "bg-bull/15 text-bull border-bull/30" },
  weak: { label: "약한 지지", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  rejected: { label: "가설 기각", cls: "bg-bear/15 text-bear border-bear/30" },
  inconclusive: {
    label: "판단 불가 (표본 부족)",
    cls: "bg-muted text-muted-foreground border-border",
  },
};

export function VerdictBadge({ verdict, className }: { verdict: Verdict; className?: string }) {
  const c = CONFIG[verdict] ?? CONFIG.inconclusive;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-2xs font-semibold uppercase tracking-wider",
        c.cls,
        className,
      )}
    >
      {c.label}
    </span>
  );
}
