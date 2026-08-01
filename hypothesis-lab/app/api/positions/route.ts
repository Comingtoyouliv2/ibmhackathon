import { NextResponse } from "next/server";
import {
  adaptPositions,
  fetchAllMids,
  fetchAllPerpStates,
} from "@/lib/hyperliquid/adapter";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    // Fetch positions across the main perp DEX + every HIP-3 dex the user
    // has touched. fetchAllPerpStates internally pulls fills once to learn
    // which dexes to query.
    const [perpStates, mids] = await Promise.all([
      fetchAllPerpStates(),
      fetchAllMids({ noStore: true }),
    ]);

    const positions = adaptPositions(perpStates, mids);
    const rawCount = [...perpStates.values()].reduce(
      (s, raw) => s + raw.assetPositions.length,
      0,
    );
    const asOf = Math.max(
      ...[...perpStates.values()].map((s) => s.time),
      0,
    );

    return NextResponse.json(
      {
        positions,
        asOf,
        rawCount,
        dexes: [...perpStates.keys()],
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error("[/api/positions] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 502 },
    );
  }
}
