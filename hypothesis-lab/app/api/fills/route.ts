import { NextResponse } from "next/server";
import { adaptFills, fetchUserFills } from "@/lib/hyperliquid/adapter";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const raw = await fetchUserFills(undefined, { noStore: true });
    return NextResponse.json(adaptFills(raw), {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    console.error("[/api/fills] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 502 },
    );
  }
}
