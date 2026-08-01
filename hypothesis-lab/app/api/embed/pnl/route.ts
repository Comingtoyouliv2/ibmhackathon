/**
 * GitHub-README-friendly SVG embed of the live PnL card.
 *
 * GitHub markdown sanitises iframes/scripts, so static SVG is the only viable
 * embed format. We render the same numbers shown on the main dashboard —
 * fetched via the existing Hyperliquid adapter, then formatted into a flat
 * dark card sized like the standard github-readme-stats badge (495 × 180).
 *
 * Usage in any README:
 *
 *   [![Live PnL](https://www.felix.trading/api/embed/pnl)](https://www.felix.trading)
 *
 * Cached at the edge for 5 min so a hot README doesn't hammer Hyperliquid.
 */

import { NextResponse } from "next/server";

import {
  adaptAccount,
  adaptPositions,
  fetchAllMids,
  fetchAllPerpStates,
  fetchSpotClearinghouseState,
  fetchUserFills,
} from "@/lib/hyperliquid/adapter";
import { publicConfig } from "@/lib/hyperliquid/config";

// Force the route to be a dynamic function — needed because the inner
// Hyperliquid fetches opt out of Next.js's cache. The 5-minute CDN window
// comes from the response's Cache-Control header below.
export const dynamic = "force-dynamic";

const CARD_W = 495;
const CARD_H = 180;

const COLORS = {
  bg: "#0d1117",
  border: "#30363d",
  divider: "#21262d",
  text: "#e6edf3",
  textMuted: "#7d8590",
  bull: "#3fb950",
  bear: "#f85149",
};

const FONT_SANS = "ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const FONT_MONO =
  "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace";

interface CardData {
  isError: boolean;
  totalPnl: number;
  totalReturnPct: number;
  equity: number;
  openPositions: number;
  traderName: string;
  startDate: string;
  walletAddress: string;
}

export async function GET() {
  let data: CardData;
  try {
    data = await loadCardData();
  } catch (err) {
    console.error("[/api/embed/pnl] failed:", err);
    data = neutralCard();
  }

  const svg = renderSvg(data);

  return new NextResponse(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  });
}

// ---------- data loading ----------

async function loadCardData(): Promise<CardData> {
  // Same fetch pattern as /api/pnl: pull fills first so fetchAllPerpStates
  // knows which HIP-3 dexes to query, then everything else in parallel.
  const fillsRaw = await fetchUserFills(undefined, { noStore: true });
  const [perpStates, spot, mids] = await Promise.all([
    fetchAllPerpStates(undefined, fillsRaw),
    fetchSpotClearinghouseState(undefined, { noStore: true }),
    fetchAllMids({ noStore: true }),
  ]);

  const account = adaptAccount(perpStates, spot);
  const positions = adaptPositions(perpStates, mids);

  const equity = account.accountValue;
  const startEquity = publicConfig.startEquity;
  const totalPnl = equity - startEquity;
  const totalReturnPct =
    startEquity > 0 ? (totalPnl / startEquity) * 100 : 0;

  return {
    isError: false,
    totalPnl,
    totalReturnPct,
    equity,
    openPositions: positions.length,
    traderName: publicConfig.traderName,
    startDate: publicConfig.startDate,
    walletAddress: publicConfig.walletAddress,
  };
}

/** Fail-soft fallback so the README badge never goes red on transient errors. */
function neutralCard(): CardData {
  return {
    isError: true,
    totalPnl: 0,
    totalReturnPct: 0,
    equity: 0,
    openPositions: 0,
    traderName: publicConfig.traderName,
    startDate: publicConfig.startDate,
    walletAddress: publicConfig.walletAddress,
  };
}

// ---------- formatting ----------

function fmtSignedUsd(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${abs}`;
}

function fmtUsdPlain(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtSignedPct(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(2)}%`;
}

function fmtStartDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function shortenAddress(a: string): string {
  if (!a || a.length < 14) return a || "";
  return `${a.slice(0, 8)}…${a.slice(-6)}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------- SVG rendering ----------

function renderSvg(d: CardData): string {
  const accent = d.isError
    ? COLORS.textMuted
    : d.totalPnl >= 0
      ? COLORS.bull
      : COLORS.bear;

  const pnlColor = d.isError
    ? COLORS.textMuted
    : d.totalPnl >= 0
      ? COLORS.bull
      : COLORS.bear;

  const headerLeft = `
    <text x="22" y="32" font-family="${FONT_SANS}" font-size="14" font-weight="600" fill="${COLORS.text}">${escapeXml(d.traderName)}</text>
    <text x="22" y="50" font-family="${FONT_SANS}" font-size="11" fill="${COLORS.textMuted}">${
      d.isError
        ? "Hyperliquid temporarily unreachable — retrying"
        : "Public Hyperliquid trading journal"
    }</text>
  `;

  const liveBadge = d.isError
    ? ""
    : `
      <circle cx="455" cy="28" r="3.5" fill="${COLORS.bull}"/>
      <text x="464" y="32" font-family="${FONT_SANS}" font-size="10" font-weight="600" fill="${COLORS.bull}" letter-spacing="1.4" text-anchor="end" transform="translate(0)">LIVE</text>
    `;

  // Three metrics laid out as columns. Column boundaries:
  //   col1: x=22  (Total Net PnL)
  //   col2: x=200 (Equity)
  //   col3: x=355 (Open positions)
  const metrics = d.isError
    ? renderErrorBlock()
    : `
      <text x="22" y="88" font-family="${FONT_SANS}" font-size="10" font-weight="600" fill="${COLORS.textMuted}" letter-spacing="1.4">TOTAL NET PNL</text>
      <text x="22" y="118" font-family="${FONT_MONO}" font-size="22" font-weight="600" fill="${pnlColor}">${escapeXml(fmtSignedUsd(d.totalPnl))}</text>
      <text x="22" y="138" font-family="${FONT_MONO}" font-size="11" fill="${pnlColor}">${escapeXml(fmtSignedPct(d.totalReturnPct))}</text>

      <text x="200" y="88" font-family="${FONT_SANS}" font-size="10" font-weight="600" fill="${COLORS.textMuted}" letter-spacing="1.4">EQUITY</text>
      <text x="200" y="118" font-family="${FONT_MONO}" font-size="22" font-weight="600" fill="${COLORS.text}">${escapeXml(fmtUsdPlain(d.equity))}</text>
      <text x="200" y="138" font-family="${FONT_SANS}" font-size="11" fill="${COLORS.textMuted}">since ${escapeXml(fmtStartDate(d.startDate))}</text>

      <text x="355" y="88" font-family="${FONT_SANS}" font-size="10" font-weight="600" fill="${COLORS.textMuted}" letter-spacing="1.4">POSITIONS</text>
      <text x="355" y="118" font-family="${FONT_MONO}" font-size="22" font-weight="600" fill="${COLORS.text}">${d.openPositions}</text>
      <text x="355" y="138" font-family="${FONT_SANS}" font-size="11" fill="${COLORS.textMuted}">${d.openPositions === 0 ? "Flat" : "Open"}</text>
    `;

  // Footer
  const footer = `
    <text x="22" y="164" font-family="${FONT_SANS}" font-size="10" fill="${COLORS.textMuted}">felix.trading</text>
    <text x="${CARD_W - 22}" y="164" text-anchor="end" font-family="${FONT_MONO}" font-size="10" fill="${COLORS.textMuted}">${escapeXml(shortenAddress(d.walletAddress))}</text>
  `;

  // Accent bar (4px) on the left edge mirrors PnL direction.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}" role="img" aria-label="Felix Choi PNL live trading card: ${escapeXml(fmtSignedUsd(d.totalPnl))} (${escapeXml(fmtSignedPct(d.totalReturnPct))})">
  <rect x="0.5" y="0.5" width="${CARD_W - 1}" height="${CARD_H - 1}" rx="6" ry="6" fill="${COLORS.bg}" stroke="${COLORS.border}" stroke-width="1"/>
  <rect x="0.5" y="0.5" width="4" height="${CARD_H - 1}" fill="${accent}"/>
  ${headerLeft}
  ${liveBadge}
  <line x1="20" y1="62" x2="${CARD_W - 20}" y2="62" stroke="${COLORS.divider}" stroke-width="1"/>
  ${metrics}
  ${footer}
</svg>`;
}

function renderErrorBlock(): string {
  return `
    <text x="22" y="100" font-family="${FONT_SANS}" font-size="13" fill="${COLORS.text}">Live data unavailable right now</text>
    <text x="22" y="120" font-family="${FONT_SANS}" font-size="11" fill="${COLORS.textMuted}">The Hyperliquid info API didn't respond. The card will refresh on the next request.</text>
  `;
}
