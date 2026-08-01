import { NextResponse } from "next/server";
import { fetchAllMids } from "@/lib/hyperliquid/adapter";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const mids = await fetchAllMids({ noStore: true });
    return NextResponse.json(mids, {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    console.error("[/api/mids] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 502 },
    );
  }
}
