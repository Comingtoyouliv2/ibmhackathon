/**
 * Aggregated dashboard endpoint.
 *
 * Total Net PnL = current total balance (main perp + every HIP-3 perp + spot)
 *                 − initial capital ($6,223).
 */

import { NextResponse } from "next/server";
import {
  adaptAccount,
  adaptFills,
  adaptPositions,
  fetchAllMids,
  fetchAllPerpStates,
  fetchSpotClearinghouseState,
  fetchUserFills,
} from "@/lib/hyperliquid/adapter";
import {
  byAsset,
  byWeekday,
  cumulativeEquity,
  dailyPnl,
  summarize,
} from "@/lib/analytics";
import { publicConfig } from "@/lib/hyperliquid/config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    // Pull fills first so we know which HIP-3 dexes the user trades on.
    const fillsRaw = await fetchUserFills(undefined, { noStore: true });

    const [perpStates, spot, mids] = await Promise.all([
      fetchAllPerpStates(undefined, fillsRaw),
      fetchSpotClearinghouseState(undefined, { noStore: true }),
      fetchAllMids({ noStore: true }),
    ]);

    const account = adaptAccount(perpStates, spot);
    const positions = adaptPositions(perpStates, mids);
    const fills = adaptFills(fillsRaw);

    const summary = summarize(fills);
    const unrealized = positions.reduce((s, p) => s + p.unrealizedPnl, 0);

    const startEquity = publicConfig.startEquity;
    const totalPnl = account.accountValue - startEquity;
    const totalReturnPct =
      startEquity > 0 ? (totalPnl / startEquity) * 100 : 0;

    return NextResponse.json(
      {
        account,
        positions,
        unrealized,
        startEquity,
        startDate: publicConfig.startDate,
        totalPnl,
        totalReturnPct,
        summary,
        daily: dailyPnl(fills),
        equity: cumulativeEquity(fills, startEquity, publicConfig.startDate),
        byAsset: byAsset(fills),
        byWeekday: byWeekday(fills),
        dexes: [...perpStates.keys()],
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error("[/api/pnl] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 502 },
    );
  }
}
