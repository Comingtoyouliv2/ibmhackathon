/** POST /api/lab/auth — exchange an access code for an unlimited-use cookie. */

import { NextRequest, NextResponse } from "next/server";

import { pack, unpack, validAccessCode } from "@/lib/lab/shared";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { code } = (await req.json().catch(() => ({}))) as { code?: string };
  if (!code || !validAccessCode(code)) {
    return NextResponse.json({ ok: false, message: "코드가 올바르지 않아요." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("lab_pass", pack("ok"), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 60 * 60 * 24 * 90,
    path: "/",
  });
  return res;
}

export async function GET(req: NextRequest) {
  const unlimited = unpack(req.cookies.get("lab_pass")?.value) === "ok";
  return NextResponse.json({ unlimited });
}
