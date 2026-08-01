"""Vercel Python function: executes a constrained analysis spec (JSON DSL)
against the bundled Hyperliquid daily dataset and returns probability stats +
chart data. The LLM never computes numbers — it only produces the spec; all
math happens here in pandas.

POST /api/pyanalyze
  {"coin": "BTC",
   "conditions": [{"type": "fomc", "action": "cut"}, ...],
   "target": {"horizonDays": 1, "direction": "up"}}
"""

from __future__ import annotations

import gzip
import io
import json
import math
import os
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
NY = ZoneInfo("America/New_York")

# FOMC calendar (federalreserve.gov). Mirrors scripts/hypothesis/events.json.
FOMC = [
    ("2023-02-01", "hike", 25, "4.50-4.75"), ("2023-03-22", "hike", 25, "4.75-5.00"),
    ("2023-05-03", "hike", 25, "5.00-5.25"), ("2023-06-14", "hold", 0, "5.00-5.25"),
    ("2023-07-26", "hike", 25, "5.25-5.50"), ("2023-09-20", "hold", 0, "5.25-5.50"),
    ("2023-11-01", "hold", 0, "5.25-5.50"), ("2023-12-13", "hold", 0, "5.25-5.50"),
    ("2024-01-31", "hold", 0, "5.25-5.50"), ("2024-03-20", "hold", 0, "5.25-5.50"),
    ("2024-05-01", "hold", 0, "5.25-5.50"), ("2024-06-12", "hold", 0, "5.25-5.50"),
    ("2024-07-31", "hold", 0, "5.25-5.50"), ("2024-09-18", "cut", 50, "4.75-5.00"),
    ("2024-11-07", "cut", 25, "4.50-4.75"), ("2024-12-18", "cut", 25, "4.25-4.50"),
    ("2025-01-29", "hold", 0, "4.25-4.50"), ("2025-03-19", "hold", 0, "4.25-4.50"),
    ("2025-05-07", "hold", 0, "4.25-4.50"), ("2025-06-18", "hold", 0, "4.25-4.50"),
    ("2025-07-30", "hold", 0, "4.25-4.50"), ("2025-09-17", "cut", 25, "4.00-4.25"),
    ("2025-10-29", "cut", 25, "3.75-4.00"), ("2025-12-10", "cut", 25, "3.50-3.75"),
    ("2026-01-28", "hold", 0, "3.50-3.75"), ("2026-03-18", "hold", 0, "3.50-3.75"),
    ("2026-04-29", "hold", 0, "3.50-3.75"), ("2026-06-17", "hold", 0, "3.50-3.75"),
]

MAX_CASES = 60
MIN_N_CONCLUSIVE = 5

_DF: pd.DataFrame | None = None  # warm-instance cache


def load_df() -> pd.DataFrame:
    global _DF
    if _DF is None:
        path = os.path.join(HERE, "_data", "hl_daily.csv.gz")
        df = pd.read_csv(path, compression="gzip")
        df["time"] = pd.to_datetime(df["time"], utc=True).dt.tz_localize(None)
        df["coin"] = df["coin"].astype(str).str.upper()
        _DF = df
    return _DF


def coin_frame(coin: str) -> pd.DataFrame | None:
    df = load_df()
    sub = df[df["coin"] == coin.upper()].sort_values("time").set_index("time")
    if sub.empty:
        return None
    d = pd.DataFrame({
        "close": sub["mark_px"],
        "funding": sub["funding"],
        "oi": sub["open_interest"],
    })
    d = d[~d.index.duplicated(keep="last")]
    d["ret"] = d["close"].pct_change() * 100
    d["oi_chg"] = d["oi"].pct_change() * 100
    return d


def binom_p_one_sided(k: int, n: int, p0: float) -> float:
    if n == 0:
        return 1.0
    p0 = min(max(p0, 1e-9), 1 - 1e-9)
    return float(sum(math.comb(n, i) * p0**i * (1 - p0) ** (n - i) for i in range(k, n + 1)))


def verdict_from(n: int, p: float) -> str:
    if n < MIN_N_CONCLUSIVE:
        return "inconclusive"
    if p < 0.05:
        return "supported"
    if p < 0.10:
        return "weak"
    return "rejected"


def fomc_dates(action: str) -> list[tuple[pd.Timestamp, str]]:
    out = []
    for date, act, bps, target in FOMC:
        if action != "any" and act != action:
            continue
        sign = {"cut": "-", "hike": "+"}.get(act, "")
        label = f"FOMC {sign}{bps}bp → {target}%" if bps else f"FOMC 동결 ({target}%)"
        out.append((pd.Timestamp(date), label))
    return out


def apply_conditions(d: pd.DataFrame, conditions: list[dict]) -> tuple[pd.Series, dict[pd.Timestamp, str]]:
    """Returns boolean mask over d.index + optional per-day labels."""
    mask = pd.Series(True, index=d.index)
    labels: dict[pd.Timestamp, str] = {}
    for c in conditions:
        t = c.get("type")
        if t == "fomc":
            pairs = fomc_dates(c.get("action", "any"))
            days = {ts: lb for ts, lb in pairs}
            m = d.index.isin(days.keys())
            for ts, lb in days.items():
                labels[ts] = lb
            mask &= pd.Series(m, index=d.index)
        elif t == "daily_return":
            v = float(c["valuePct"])
            m = d["ret"] <= v if c.get("op", "lte") == "lte" else d["ret"] >= v
            mask &= m.fillna(False)
        elif t == "streak":
            up = d["ret"] > 0 if c.get("direction", "up") == "up" else d["ret"] < 0
            days = max(1, min(int(c.get("days", 3)), 10))
            m = up.copy()
            for i in range(1, days):
                m &= up.shift(i).fillna(False)
            mask &= m.fillna(False)
        elif t == "funding":
            v = float(c.get("value", 0))
            m = d["funding"] <= v if c.get("op", "lte") == "lte" else d["funding"] >= v
            mask &= m.fillna(False)
        elif t == "funding_percentile":
            pct = max(1, min(int(c.get("pct", 10)), 50))
            if c.get("side", "bottom") == "bottom":
                thr = d["funding"].quantile(pct / 100)
                m = d["funding"] <= thr
            else:
                thr = d["funding"].quantile(1 - pct / 100)
                m = d["funding"] >= thr
            mask &= m.fillna(False)
        elif t == "oi_change":
            v = float(c["valuePct"])
            m = d["oi_chg"] >= v if c.get("op", "gte") == "gte" else d["oi_chg"] <= v
            mask &= m.fillna(False)
        elif t == "weekday":
            days = [int(x) for x in c.get("days", [])]
            mask &= pd.Series(d.index.dayofweek.isin(days), index=d.index)
        elif t == "month":
            months = [int(x) for x in c.get("months", [])]
            mask &= pd.Series(d.index.month.isin(months), index=d.index)
        else:
            raise ValueError(f"unknown condition type: {t}")
    return mask, labels


def calendar_context(d: pd.DataFrame, conditions: list[dict]) -> dict | None:
    """Full weekday/month distribution when the query is calendar-based."""
    types = {c.get("type") for c in conditions}
    if "weekday" in types:
        names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        g = d.groupby(d.index.dayofweek)["ret"]
        data = [{"label": names[i], "avgReturnPct": round(float(v.mean()), 3), "n": int(v.count()),
                 "upRate": round(float((v > 0).mean()), 3)} for i, v in g]
        return {"type": "categoryBars", "data": data}
    if "month" in types:
        names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        monthly = d["ret"].div(100).add(1).groupby([d.index.year, d.index.month]).prod().sub(1).mul(100)
        by_m: dict[int, list[float]] = {}
        for (y, m), v in monthly.items():
            by_m.setdefault(int(m), []).append(float(v))
        data = [{"label": names[m - 1], "avgReturnPct": round(float(np.mean(v)), 2), "n": len(v),
                 "upRate": round(float(np.mean([x > 0 for x in v])), 3)} for m, v in sorted(by_m.items())]
        return {"type": "categoryBars", "data": data}
    return None


def execute(spec: dict) -> dict:
    coin = str(spec.get("coin", "BTC")).upper()
    d = coin_frame(coin)
    if d is None:
        available = sorted(load_df()["coin"].unique().tolist())
        near = [c for c in available if coin[:2] in c][:8]
        return {"error": "unknown_coin", "message": f"'{coin}' 데이터가 없습니다.", "suggestions": near}

    conditions = spec.get("conditions", [])
    target = spec.get("target", {})
    horizon = max(1, min(int(target.get("horizonDays", 1)), 30))
    direction = target.get("direction", "up")

    fwd = (d["close"].shift(-horizon) / d["close"] - 1) * 100
    mask, labels = apply_conditions(d, conditions)
    mask &= fwd.notna()

    base_pool = fwd.dropna()
    base_up = float((base_pool > 0).mean()) if len(base_pool) else 0.5
    p0 = base_up if direction == "up" else 1 - base_up

    events = fwd[mask]
    cases = []
    for ts, r in events.items():
        row = d.loc[ts]
        default_label = f"당일 {row['ret']:+.1f}%" if not np.isnan(row["ret"]) else ""
        hit = r > 0 if direction == "up" else r < 0
        cases.append({"date": ts.strftime("%Y-%m-%d"), "label": labels.get(ts, default_label),
                      "returnPct": round(float(r), 2), "hit": bool(hit)})
    n = len(cases)
    k = sum(c["hit"] for c in cases)
    p = binom_p_one_sided(k, n, p0)
    rets = [c["returnPct"] for c in cases]

    chart = calendar_context(d, conditions) or {"type": "eventBars"}
    shown = cases[-MAX_CASES:]
    note = f"전체 {n}건 중 최근 {len(shown)}건 표시" if n > MAX_CASES else None
    if note:
        chart = {**chart, "note": note}

    return {
        "meta": {
            "coin": coin,
            "start": d.index[0].strftime("%Y-%m-%d"),
            "end": d.index[-1].strftime("%Y-%m-%d"),
            "days": int(len(d)),
            "horizonDays": horizon,
            "direction": direction,
            "generatedAt": datetime.utcnow().isoformat() + "Z",
        },
        "stats": {
            "n": n, "hits": int(k),
            "hitRate": round(k / n, 3) if n else None,
            "baselineRate": round(p0, 3),
            "avgReturnPct": round(float(np.mean(rets)), 2) if rets else None,
            "medianReturnPct": round(float(np.median(rets)), 2) if rets else None,
            "pValue": round(p, 4),
            "verdict": verdict_from(n, p),
        },
        "cases": shown,
        "chart": chart,
    }


class handler(BaseHTTPRequestHandler):  # noqa: N801 (vercel convention)
    def do_POST(self):  # noqa: N802
        try:
            length = int(self.headers.get("Content-Length", 0))
            spec = json.loads(self.rfile.read(length) or b"{}")
            result = execute(spec)
            body = json.dumps(result, ensure_ascii=False).encode()
            self.send_response(200)
        except Exception as e:  # noqa: BLE001
            body = json.dumps({"error": "execution_failed", "message": str(e)}, ensure_ascii=False).encode()
            self.send_response(400)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
