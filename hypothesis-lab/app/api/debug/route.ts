/**
 * Diagnostic endpoint. Open /api/debug to verify:
 *   - which wallet the server is querying
 *   - main perp clearinghouseState
 *   - every HIP-3 dex clearinghouseState the user trades on
 *   - spot balances
 *   - sub-accounts
 *   - userFills summary
 */

import { NextResponse } from "next/server";
import {
  discoverHip3Dexes,
  fetchClearinghouseState,
  fetchSpotClearinghouseState,
  fetchSubAccounts,
  fetchUserFills,
} from "@/lib/hyperliquid/adapter";
import { serverConfig } from "@/lib/hyperliquid/config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const result: Record<string, unknown> = {
    walletAddress: serverConfig.walletAddress,
    apiUrl: serverConfig.apiUrl,
  };

  let fillsRaw: Awaited<ReturnType<typeof fetchUserFills>> = [];
  try {
    fillsRaw = await fetchUserFills(undefined, { noStore: true });
    result.fills = {
      count: fillsRaw.length,
      latest: fillsRaw[0]
        ? {
            coin: fillsRaw[0].coin,
            side: fillsRaw[0].side,
            dir: fillsRaw[0].dir,
            time: fillsRaw[0].time,
            closedPnl: fillsRaw[0].closedPnl,
          }
        : null,
      hip3DexesDiscovered: discoverHip3Dexes(fillsRaw),
    };
  } catch (err) {
    result.fillsError = err instanceof Error ? err.message : String(err);
  }

  // Main perp DEX.
  try {
    const perp = await fetchClearinghouseState(undefined, { noStore: true });
    result.mainPerp = summarisePerp(perp);
  } catch (err) {
    result.mainPerpError = err instanceof Error ? err.message : String(err);
  }

  // Each HIP-3 dex the user touched.
  const dexes = discoverHip3Dexes(fillsRaw);
  if (dexes.length) {
    const hip3: Record<string, unknown> = {};
    await Promise.all(
      dexes.map(async (dex) => {
        try {
          const raw = await fetchClearinghouseState(undefined, {
            noStore: true,
            dex,
          });
          hip3[dex] = summarisePerp(raw);
        } catch (err) {
          hip3[dex] = {
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    result.hip3 = hip3;
  }

  try {
    const spot = await fetchSpotClearinghouseState(undefined, {
      noStore: true,
    });
    result.spot = {
      balancesCount: spot.balances.length,
      balances: spot.balances,
    };
  } catch (err) {
    result.spotError = err instanceof Error ? err.message : String(err);
  }

  try {
    result.subAccounts = await fetchSubAccounts(undefined, { noStore: true });
  } catch (err) {
    result.subAccountsError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json(result, {
    headers: { "cache-control": "no-store" },
  });
}

function summarisePerp(raw: {
  marginSummary: { accountValue: string };
  assetPositions: Array<{
    position: {
      coin: string;
      szi: string;
      entryPx: string;
      unrealizedPnl: string;
      leverage: unknown;
    };
  }>;
  withdrawable: string;
  time: number;
}) {
  return {
    accountValue: raw.marginSummary.accountValue,
    assetPositionsCount: raw.assetPositions.length,
    positions: raw.assetPositions.map((ap) => ({
      coin: ap.position.coin,
      szi: ap.position.szi,
      entryPx: ap.position.entryPx,
      unrealizedPnl: ap.position.unrealizedPnl,
      leverage: ap.position.leverage,
    })),
    withdrawable: raw.withdrawable,
    time: raw.time,
  };
}
