/**
 * POST /api/lab — live hypothesis analysis.
 * Flow: auth/quota → Claude parses question → Python function computes stats →
 * Claude + OpenAI independently verify → response.
 *
 * Numbers are only ever produced by the Python engine; both LLMs see the same
 * computed stats and never each other's answers (hallucination cross-check).
 */

import { NextRequest, NextResponse } from "next/server";

import { dualVerify, parseQuestion } from "@/lib/lab/llm";
import {
  GUEST_DAILY_LIMIT,
  type LabExecution,
  type LabResponse,
  agreement,
  pack,
  unpack,
} from "@/lib/lab/shared";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_QUESTION_LEN = 300;

/** Best-effort per-IP counter (per warm instance) — second layer on top of the cookie. */
const ipHits = new Map<string, { day: string; count: number }>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function guestQuota(req: NextRequest): { allowed: boolean; used: number } {
  const day = today();
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const mem = ipHits.get(ip);
  const memCount = mem && mem.day === day ? mem.count : 0;

  const raw = unpack(req.cookies.get("lab_quota")?.value);
  let cookieCount = 0;
  if (raw) {
    const [d, c] = raw.split(":");
    if (d === day) cookieCount = parseInt(c, 10) || 0;
  }
  const used = Math.max(memCount, cookieCount);
  return { allowed: used < GUEST_DAILY_LIMIT, used };
}

function bumpGuest(req: NextRequest, res: NextResponse, used: number) {
  const day = today();
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  ipHits.set(ip, { day, count: used + 1 });
  if (ipHits.size > 5000) ipHits.clear();
  res.cookies.set("lab_quota", pack(`${day}:${used + 1}`), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 60 * 60 * 24,
    path: "/",
  });
}

async function runPython(req: NextRequest, spec: unknown): Promise<LabExecution> {
  const base =
    process.env.LAB_PY_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : new URL(req.url).origin);
  const res = await fetch(`${base}/api/pyanalyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
    cache: "no-store",
  });
  const body = (await res.json()) as LabExecution;
  if (!res.ok && !body.error) throw new Error(`python ${res.status}`);
  return body;
}

export async function POST(req: NextRequest) {
  const { question } = (await req.json().catch(() => ({}))) as { question?: string };
  if (!question || typeof question !== "string" || !question.trim()) {
    return NextResponse.json({ error: "empty_question", message: "질문을 입력해줘요." }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LEN) {
    return NextResponse.json(
      { error: "too_long", message: `질문은 ${MAX_QUESTION_LEN}자 이내로 해주세요.` },
      { status: 400 },
    );
  }

  // --- auth / quota
  const pass = unpack(req.cookies.get("lab_pass")?.value);
  const unlimited = pass === "ok";
  let guestUsed = 0;
  if (!unlimited) {
    const q = guestQuota(req);
    guestUsed = q.used;
    if (!q.allowed) {
      return NextResponse.json(
        {
          error: "quota_exceeded",
          message: `게스트는 하루 ${GUEST_DAILY_LIMIT}회까지 분석할 수 있어요. 접근 코드가 있다면 입력해 주세요.`,
          quota: { unlimited: false, remaining: 0 },
        },
        { status: 429 },
      );
    }
  }

  try {
    // --- 1. parse
    const spec = await parseQuestion(question.trim());
    if (spec.unsupported) {
      const res = NextResponse.json({
        question,
        spec,
        result: null,
        ai: { claude: null, openai: null, agreement: "unverified" },
        quota: { unlimited, remaining: unlimited ? -1 : GUEST_DAILY_LIMIT - guestUsed },
        error: "unsupported",
        message: spec.reason ?? "이 데이터셋으로는 검증할 수 없는 질문이에요.",
      } satisfies LabResponse);
      return res; // unsupported questions don't consume quota
    }

    // --- 2. execute (python / pandas)
    const result = await runPython(req, spec);
    if (result.error) {
      return NextResponse.json({
        question,
        spec,
        result,
        ai: { claude: null, openai: null, agreement: "unverified" },
        quota: { unlimited, remaining: unlimited ? -1 : GUEST_DAILY_LIMIT - guestUsed },
        error: result.error,
        message: result.message,
      } satisfies LabResponse);
    }

    // --- 3. dual verification
    const { claude, openai } = await dualVerify(question.trim(), spec, result);

    const res = NextResponse.json({
      question,
      spec,
      result,
      ai: { claude, openai, agreement: agreement(claude, openai) },
      quota: {
        unlimited,
        remaining: unlimited ? -1 : GUEST_DAILY_LIMIT - guestUsed - 1,
      },
    } satisfies LabResponse);
    res.headers.set("Cache-Control", "no-store");
    if (!unlimited) bumpGuest(req, res, guestUsed);
    return res;
  } catch (e) {
    console.error("lab analyze failed:", e);
    return NextResponse.json(
      { error: "analyze_failed", message: "분석 중 오류가 났어요. 잠시 후 다시 시도해 주세요." },
      { status: 500 },
    );
  }
}
