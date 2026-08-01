"""Hypothesis backtest engine.

Each hypothesis is phrased the way a user would ask it in chat, then tested
mechanically over the full dataset. Verdicts are rule-based and transparent;
AI commentary (Claude + OpenAI) is layered on top, never replaces the math.
"""

from __future__ import annotations

import json
import math
import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from loader import Dataset

HERE = os.path.dirname(os.path.abspath(__file__))
NY = ZoneInfo("America/New_York")

MIN_N_CONCLUSIVE = 5
P_SUPPORTED = 0.10  # exploratory threshold; flagged as weak unless < 0.05


# ---------------------------------------------------------------- statistics

def binom_p_one_sided(k: int, n: int, p0: float) -> float:
    """P(X >= k) under Binomial(n, p0)."""
    if n == 0:
        return 1.0
    return sum(math.comb(n, i) * p0**i * (1 - p0) ** (n - i) for i in range(k, n + 1))


def bootstrap_mean_p(sample: np.ndarray, population: np.ndarray, n_iter: int = 20000, seed: int = 42) -> float:
    """P(random same-size draw from population has mean >= sample mean)."""
    if len(sample) == 0 or len(population) == 0:
        return 1.0
    rng = np.random.default_rng(seed)
    draws = rng.choice(population, size=(n_iter, len(sample)), replace=True).mean(axis=1)
    return float((draws >= sample.mean()).mean())


def verdict_from(n: int, p: float) -> str:
    if n < MIN_N_CONCLUSIVE:
        return "inconclusive"
    if p < 0.05:
        return "supported"
    if p < P_SUPPORTED:
        return "weak"
    return "rejected"


# ---------------------------------------------------------------- event math

def fomc_events(start: pd.Timestamp, end: pd.Timestamp) -> list[dict]:
    with open(os.path.join(HERE, "events.json")) as f:
        events = json.load(f)["fomc"]
    out = []
    for e in events:
        d = datetime.strptime(e["date"], "%Y-%m-%d")
        announce = datetime(d.year, d.month, d.day, 14, 0, tzinfo=NY).astimezone(ZoneInfo("UTC"))
        ts = pd.Timestamp(announce)
        if start <= ts <= end:
            out.append({**e, "announce_utc": ts})
    return out


def event_return(ds: Dataset, announce: pd.Timestamp, hours: int = 24) -> dict | None:
    """Return over [last close before announce, announce + hours]."""
    if ds.hourly is not None:
        px = ds.hourly["close"]
        before = px[px.index <= announce]
        after = px[px.index <= announce + timedelta(hours=hours)]
        if before.empty or after.empty or after.index[-1] <= before.index[-1]:
            return None
        p0, p1 = float(before.iloc[-1]), float(after.iloc[-1])
    else:
        # Daily snapshots: last close at/before the announcement (day-of 00:00 UTC)
        # → next day's 00:00 UTC close = the announcement-day return.
        px = ds.daily["close"]
        day = announce.normalize()
        before = px[px.index <= day]
        after = px[px.index <= day + timedelta(days=1)]
        if before.empty or after.empty or after.index[-1] <= before.index[-1]:
            return None
        p0, p1 = float(before.iloc[-1]), float(after.iloc[-1])
    return {"priceBefore": p0, "priceAfter": p1, "returnPct": (p1 / p0 - 1) * 100}


# ---------------------------------------------------------------- hypotheses

def h_fomc_direction(ds: Dataset, action: str, direction: str, hid: str, question: str, question_en: str, baseline_up: float) -> dict:
    events = [e for e in fomc_events(ds.daily.index[0], ds.daily.index[-1]) if e["action"] == action]
    cases = []
    for e in events:
        r = event_return(ds, e["announce_utc"])
        if r is None:
            continue
        hit = r["returnPct"] > 0 if direction == "up" else r["returnPct"] < 0
        sign = "-" if action == "cut" else "+"
        label = f"{sign}{e['bps']}bp → {e['target']}%" if e["bps"] else f"동결 ({e['target']}%)"
        cases.append({"date": e["date"], "label": label, "returnPct": round(r["returnPct"], 2),
                      "priceBefore": round(r["priceBefore"], 1), "priceAfter": round(r["priceAfter"], 1), "hit": bool(hit)})
    n, k = len(cases), sum(c["hit"] for c in cases)
    p0 = baseline_up if direction == "up" else 1 - baseline_up
    p = binom_p_one_sided(k, n, p0)
    rets = [c["returnPct"] for c in cases]
    return {
        "id": hid, "question": question, "questionEn": question_en, "category": "macro",
        "method": ("FOMC 발표(미 동부 14:00) 직전 종가 → 발표 후 24시간 수익률."
                   if ds.hourly is not None
                   else "FOMC 발표일 00:00 UTC 종가 → 익일 00:00 UTC 종가 (발표 당일 일봉 수익률). 발표는 당일 18~19시 UTC."),
        "stats": {"n": n, "hits": k, "hitRate": round(k / n, 3) if n else None,
                  "baselineRate": round(p0, 3), "avgReturnPct": round(float(np.mean(rets)), 2) if rets else None,
                  "medianReturnPct": round(float(np.median(rets)), 2) if rets else None,
                  "pValue": round(p, 4), "verdict": verdict_from(n, p)},
        "cases": cases, "chart": {"type": "eventBars"},
    }


def h_fomc_volatility(ds: Dataset) -> dict:
    daily = ds.daily.copy()
    has_range = bool((daily["high"] != daily["low"]).any())
    if has_range:
        daily["range_pct"] = (daily["high"] - daily["low"]) / daily["close"].shift(1) * 100
        vol_desc = "일봉 고저폭(전일 종가 대비 %)"
    else:
        daily["range_pct"] = daily["close"].pct_change().abs() * 100
        vol_desc = "일간 수익률 절대값(%)"
    dates = {e["date"] for e in fomc_events(daily.index[0], daily.index[-1])}
    is_fomc = daily.index.strftime("%Y-%m-%d").isin(dates)
    ev, base = daily.loc[is_fomc, "range_pct"].dropna(), daily.loc[~is_fomc, "range_pct"].dropna()
    p = bootstrap_mean_p(ev.to_numpy(), base.to_numpy())
    cases = [{"date": d.strftime("%Y-%m-%d"), "label": "FOMC", "returnPct": round(float(v), 2),
              "hit": bool(v > base.mean())} for d, v in ev.items()]
    return {
        "id": "fomc-volatility", "question": "FOMC 발표일엔 비트코인 변동성이 평소보다 클까?",
        "questionEn": "Is BTC more volatile on FOMC days?", "category": "macro",
        "method": f"{vol_desc}을 FOMC일 vs 비FOMC일로 비교, 부트스트랩 20,000회 p-value.",
        "stats": {"n": len(ev), "hits": int(sum(c["hit"] for c in cases)), "hitRate": round(sum(c["hit"] for c in cases) / len(ev), 3) if len(ev) else None,
                  "baselineRate": None, "avgReturnPct": round(float(ev.mean()), 2) if len(ev) else None,
                  "medianReturnPct": round(float(base.mean()), 2), "pValue": round(p, 4),
                  "verdict": verdict_from(len(ev), p),
                  "extra": {"fomcAvgRangePct": round(float(ev.mean()), 2), "normalAvgRangePct": round(float(base.mean()), 2)}},
        "cases": cases, "chart": {"type": "eventBars", "unit": "range%"},
    }


def h_threshold_next_day(ds: Dataset, hid: str, question: str, question_en: str, thresh: float, direction_next: str, baseline_up: float) -> dict:
    daily = ds.daily.copy()
    daily["ret"] = daily["close"].pct_change() * 100
    daily["next_ret"] = daily["ret"].shift(-1)
    trig = daily[daily["ret"] <= thresh] if thresh < 0 else daily[daily["ret"] >= thresh]
    trig = trig.dropna(subset=["next_ret"])
    cases = [{"date": d.strftime("%Y-%m-%d"), "label": f"당일 {r.ret:+.1f}%", "returnPct": round(float(r.next_ret), 2),
              "hit": bool(r.next_ret > 0 if direction_next == "up" else r.next_ret < 0)}
             for d, r in trig.iterrows()]
    n, k = len(cases), sum(c["hit"] for c in cases)
    p0 = baseline_up if direction_next == "up" else 1 - baseline_up
    p = binom_p_one_sided(k, n, p0)
    rets = [c["returnPct"] for c in cases]
    return {
        "id": hid, "question": question, "questionEn": question_en, "category": "price",
        "method": f"UTC 일봉 기준 당일 수익률이 {thresh:+.0f}% {'이하' if thresh < 0 else '이상'}인 날 탐지 → 다음날 수익률 측정. 이항검정 vs 무조건부 상승확률.",
        "stats": {"n": n, "hits": k, "hitRate": round(k / n, 3) if n else None, "baselineRate": round(p0, 3),
                  "avgReturnPct": round(float(np.mean(rets)), 2) if rets else None,
                  "medianReturnPct": round(float(np.median(rets)), 2) if rets else None,
                  "pValue": round(p, 4), "verdict": verdict_from(n, p)},
        "cases": cases, "chart": {"type": "eventBars"},
    }


def h_streak(ds: Dataset, baseline_up: float) -> dict:
    daily = ds.daily.copy()
    daily["ret"] = daily["close"].pct_change() * 100
    daily["up"] = daily["ret"] > 0
    daily["next_ret"] = daily["ret"].shift(-1)
    streak = daily["up"] & daily["up"].shift(1) & daily["up"].shift(2)
    trig = daily[streak].dropna(subset=["next_ret"])
    cases = [{"date": d.strftime("%Y-%m-%d"), "label": "3연속 상승", "returnPct": round(float(r.next_ret), 2),
              "hit": bool(r.next_ret > 0)} for d, r in trig.iterrows()]
    n, k = len(cases), sum(c["hit"] for c in cases)
    p = binom_p_one_sided(k, n, baseline_up)
    rets = [c["returnPct"] for c in cases]
    return {
        "id": "green-streak", "question": "3일 연속 오르면 다음날도 오를까? (모멘텀 지속)",
        "questionEn": "After 3 green days, does day 4 continue up?", "category": "price",
        "method": "UTC 일봉 3연속 양봉 다음날 수익률. 이항검정 vs 무조건부 상승확률.",
        "stats": {"n": n, "hits": k, "hitRate": round(k / n, 3) if n else None, "baselineRate": round(baseline_up, 3),
                  "avgReturnPct": round(float(np.mean(rets)), 2) if rets else None,
                  "medianReturnPct": round(float(np.median(rets)), 2) if rets else None,
                  "pValue": round(p, 4), "verdict": verdict_from(n, p)},
        "cases": cases[-40:], "chart": {"type": "eventBars", "note": "최근 40건 표시"},
    }


def h_weekend(ds: Dataset) -> dict:
    daily = ds.daily.copy()
    daily["ret"] = daily["close"].pct_change() * 100
    wknd = daily[daily.index.dayofweek >= 5]["ret"].dropna()
    wkdy = daily[daily.index.dayofweek < 5]["ret"].dropna()
    # one-sided: weekend mean LOWER than weekday draws
    p = 1 - bootstrap_mean_p(wknd.to_numpy(), wkdy.to_numpy())
    by_dow = daily.groupby(daily.index.dayofweek)["ret"].agg(["mean", "count", lambda s: (s > 0).mean()])
    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    dist = [{"label": days[i], "avgReturnPct": round(float(r["mean"]), 3), "n": int(r["count"]),
             "upRate": round(float(r["<lambda_0>"]), 3)} for i, r in by_dow.iterrows()]
    n = len(wknd)
    return {
        "id": "weekend-effect", "question": "주말엔 비트코인이 약할까? (주말 효과)",
        "questionEn": "Is BTC weaker on weekends?", "category": "seasonality",
        "method": "UTC 일봉 요일별 평균 수익률. 주말(토·일) 평균이 평일 대비 낮은지 부트스트랩 검정.",
        "stats": {"n": n, "hits": int((wknd < 0).sum()), "hitRate": round(float((wknd < 0).mean()), 3),
                  "baselineRate": round(float((wkdy < 0).mean()), 3),
                  "avgReturnPct": round(float(wknd.mean()), 3), "medianReturnPct": round(float(wkdy.mean()), 3),
                  "pValue": round(p, 4), "verdict": verdict_from(n, p),
                  "extra": {"weekendAvgPct": round(float(wknd.mean()), 3), "weekdayAvgPct": round(float(wkdy.mean()), 3)}},
        "cases": [], "chart": {"type": "categoryBars", "data": dist},
    }


def h_funding(ds: Dataset, baseline_up: float) -> dict | None:
    if "funding" not in ds.daily.columns:
        return None
    daily = ds.daily.copy()
    daily["ret"] = daily["close"].pct_change() * 100
    daily["next_ret"] = daily["ret"].shift(-1)
    trig = daily[daily["funding"] < 0].dropna(subset=["next_ret"])
    cases = [{"date": d.strftime("%Y-%m-%d"), "label": f"펀딩 {r.funding * 100:.4f}%", "returnPct": round(float(r.next_ret), 2),
              "hit": bool(r.next_ret > 0)} for d, r in trig.iterrows()]
    n, k = len(cases), sum(c["hit"] for c in cases)
    p = binom_p_one_sided(k, n, baseline_up)
    rets = [c["returnPct"] for c in cases]
    return {
        "id": "negative-funding", "question": "펀딩비가 마이너스면(숏 과밀) 다음날 반등할까?",
        "questionEn": "Does negative funding (crowded shorts) precede a bounce?", "category": "price",
        "method": "Hyperliquid BTC 펀딩비가 음수인 날(숏이 롱에게 지불 = 숏 과밀) 탐지 → 다음날 수익률. 이항검정 vs 무조건부 상승확률.",
        "stats": {"n": n, "hits": k, "hitRate": round(k / n, 3) if n else None, "baselineRate": round(baseline_up, 3),
                  "avgReturnPct": round(float(np.mean(rets)), 2) if rets else None,
                  "medianReturnPct": round(float(np.median(rets)), 2) if rets else None,
                  "pValue": round(p, 4), "verdict": verdict_from(n, p)},
        "cases": cases[-40:], "chart": {"type": "eventBars", "note": "최근 40건 표시"},
    }


def h_monthly(ds: Dataset) -> dict:
    daily = ds.daily.copy()
    daily["ret"] = daily["close"].pct_change()
    monthly = daily["ret"].add(1).groupby([daily.index.year, daily.index.month]).prod().sub(1).mul(100)
    by_m: dict[int, list[float]] = {}
    for (y, m), v in monthly.items():
        by_m.setdefault(m, []).append(float(v))
    names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    dist = [{"label": names[m - 1], "avgReturnPct": round(float(np.mean(v)), 2), "n": len(v),
             "upRate": round(float(np.mean([x > 0 for x in v])), 3)} for m, v in sorted(by_m.items())]
    octs = by_m.get(10, [])
    others = [x for m, v in by_m.items() if m != 10 for x in v]
    p = bootstrap_mean_p(np.array(octs), np.array(others)) if octs else 1.0
    cases = [{"date": f"{y}-10", "label": f"{y}년 10월", "returnPct": round(float(v), 2), "hit": bool(v > 0)}
             for (y, m), v in monthly.items() if m == 10]
    return {
        "id": "uptober", "question": "'업토버'는 진짜일까? 10월은 항상 오를까?",
        "questionEn": "Is 'Uptober' real?", "category": "seasonality",
        "method": "월별 복리 수익률 집계. 10월 평균이 나머지 달 대비 높은지 부트스트랩 검정.",
        "stats": {"n": len(octs), "hits": sum(c["hit"] for c in cases), "hitRate": round(float(np.mean([x > 0 for x in octs])), 3) if octs else None,
                  "baselineRate": round(float(np.mean([x > 0 for x in others])), 3) if others else None,
                  "avgReturnPct": round(float(np.mean(octs)), 2) if octs else None,
                  "medianReturnPct": round(float(np.mean(others)), 2) if others else None,
                  "pValue": round(p, 4), "verdict": verdict_from(len(octs), p)},
        "cases": cases, "chart": {"type": "categoryBars", "data": dist},
    }


# ---------------------------------------------------------------- runner

def run_all(ds: Dataset) -> dict:
    daily = ds.daily.copy()
    rets = daily["close"].pct_change().dropna()
    baseline_up = float((rets > 0).mean())

    hypos = [
        h_fomc_direction(ds, "cut", "up", "fed-cut-pump",
                         "FED가 금리를 인하하면 비트코인은 올랐을까?",
                         "Does BTC pump when the Fed cuts rates?", baseline_up),
        h_fomc_direction(ds, "hike", "down", "fed-hike-dump",
                         "FED가 금리를 인상하면 비트코인은 떨어졌을까?",
                         "Does BTC dump when the Fed hikes rates?", baseline_up),
        h_fomc_volatility(ds),
        h_threshold_next_day(ds, "crash-bounce", "하루 -5% 급락하면 다음날 반등할까?",
                             "Does BTC bounce the day after a -5% crash?", -5.0, "up", baseline_up),
        h_streak(ds, baseline_up),
        h_weekend(ds),
        h_monthly(ds),
    ]
    funding = h_funding(ds, baseline_up)
    if funding is not None:
        hypos.insert(4, funding)

    return {
        "generatedAt": datetime.utcnow().isoformat() + "Z",
        "dataset": {
            "coin": ds.coin,
            "start": daily.index[0].strftime("%Y-%m-%d"),
            "end": daily.index[-1].strftime("%Y-%m-%d"),
            "days": int(len(daily)),
            "nativeInterval": ds.native_interval,
            "sourceFiles": [os.path.basename(f) for f in ds.source_files],
        },
        "baseline": {
            "upDayProb": round(baseline_up, 3),
            "avgDailyRetPct": round(float(rets.mean() * 100), 3),
            "dailyVolPct": round(float(rets.std() * 100), 2),
        },
        "hypotheses": hypos,
    }
