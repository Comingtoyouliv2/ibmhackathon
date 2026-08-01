/** Shared types + helpers for the live Hypothesis Lab. Server-side only where noted. */

import { createHmac, timingSafeEqual } from "crypto";

import type { Agreement, AiOpinion, HypothesisCase, Verdict } from "@/lib/hypothesis/types";

// ------------------------------------------------------------------ spec DSL

export interface LabCondition {
  type:
    | "fomc"
    | "daily_return"
    | "streak"
    | "funding"
    | "funding_percentile"
    | "oi_change"
    | "weekday"
    | "month";
  [key: string]: unknown;
}

export interface LabSpec {
  coin: string;
  conditions: LabCondition[];
  target: { horizonDays: number; direction: "up" | "down" };
  /** One-line Korean restatement of how the question was interpreted. */
  interpretation?: string;
  unsupported?: boolean;
  reason?: string;
}

export interface LabExecution {
  meta: {
    coin: string;
    start: string;
    end: string;
    days: number;
    horizonDays: number;
    direction: string;
    generatedAt: string;
  };
  stats: {
    n: number;
    hits: number;
    hitRate: number | null;
    baselineRate: number | null;
    avgReturnPct: number | null;
    medianReturnPct: number | null;
    pValue: number;
    verdict: Verdict;
  };
  cases: HypothesisCase[];
  chart: { type: "eventBars" | "categoryBars"; data?: unknown[]; note?: string };
  error?: string;
  message?: string;
  suggestions?: string[];
}

export interface LabResponse {
  question: string;
  spec: LabSpec;
  result: LabExecution | null;
  ai: { claude: AiOpinion | null; openai: AiOpinion | null; agreement: Agreement };
  quota: { unlimited: boolean; remaining: number };
  error?: string;
  message?: string;
}

// ------------------------------------------------------------- auth (server)

const secret = () =>
  process.env.LAB_COOKIE_SECRET || process.env.LAB_ACCESS_CODES || "lab-dev-secret";

export function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("hex").slice(0, 32);
}

export function pack(value: string): string {
  return `${value}.${sign(value)}`;
}

export function unpack(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const i = cookie.lastIndexOf(".");
  if (i < 0) return null;
  const value = cookie.slice(0, i);
  const sig = cookie.slice(i + 1);
  const expected = sign(value);
  try {
    if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return value;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function validAccessCode(code: string): boolean {
  const codes = (process.env.LAB_ACCESS_CODES || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return codes.includes(code.trim());
}

export const GUEST_DAILY_LIMIT = 3;

export function agreement(
  a: AiOpinion | null,
  b: AiOpinion | null,
): Agreement {
  if (!a || !b) return "unverified";
  if (a.verdict === b.verdict) return "agree";
  const soft = new Set([
    "supported|weak",
    "weak|supported",
    "rejected|inconclusive",
    "inconclusive|rejected",
    "weak|inconclusive",
    "inconclusive|weak",
  ]);
  return soft.has(`${a.verdict}|${b.verdict}`) ? "partial" : "disagree";
}
