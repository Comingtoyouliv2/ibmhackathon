import { NextResponse } from "next/server";
import {
  adaptAccount,
  fetchAllPerpStates,
  fetchSpotClearinghouseState,
} from "@/lib/hyperliquid/adapter";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const [perpStates, spot] = await Promise.all([
      fetchAllPerpStates(),
      fetchSpotClearinghouseState(undefined, { noStore: true }),
    ]);
    return NextResponse.json(adaptAccount(perpStates, spot), {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    console.error("[/api/account] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 502 },
    );
  }
}
