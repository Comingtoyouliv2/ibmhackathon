"""Flexible loader for the Hyperliquid OHLCV dataset.

Accepts CSV or Parquet with loosely-named columns. Normalizes to a daily
(UTC) and, when the source is intraday, hourly DataFrame with columns:
open, high, low, close, volume — indexed by tz-aware UTC DatetimeIndex.
"""

from __future__ import annotations

import glob
import os
from dataclasses import dataclass

import pandas as pd

TIME_ALIASES = ["timestamp", "time", "ts", "datetime", "date", "t", "open_time", "opentime"]
COL_ALIASES = {
    "open": ["open", "o"],
    "high": ["high", "h"],
    "low": ["low", "l"],
    "close": ["close", "c", "price", "mark_px", "markpx", "px"],
    "volume": ["volume", "v", "vol", "volume_usd", "quote_volume"],
    "funding": ["funding", "funding_rate", "fundingrate"],
    "open_interest": ["open_interest", "oi", "openinterest"],
}
COIN_ALIASES = ["coin", "symbol", "asset", "ticker", "pair", "market"]


@dataclass
class Dataset:
    daily: pd.DataFrame           # daily UTC bars
    hourly: pd.DataFrame | None   # hourly UTC bars if source is intraday
    coin: str
    source_files: list[str]
    native_interval: str          # e.g. "1d", "1h", "5m" (best guess)


def _find_col(cols: list[str], aliases: list[str]) -> str | None:
    lower = {c.lower().strip(): c for c in cols}
    for a in aliases:
        if a in lower:
            return lower[a]
    return None


def _read_any(path: str) -> pd.DataFrame:
    if path.endswith((".parquet", ".pq")):
        return pd.read_parquet(path)
    if path.endswith(".json"):
        return pd.read_json(path)
    return pd.read_csv(path)


def _parse_time(s: pd.Series) -> pd.Series:
    if pd.api.types.is_numeric_dtype(s):
        mx = float(s.max())
        unit = "ms" if mx > 1e11 else "s"
        return pd.to_datetime(s, unit=unit, utc=True)
    return pd.to_datetime(s, utc=True, format="mixed")


def load(data_dir: str, coin: str = "BTC") -> Dataset:
    patterns = ["*.csv", "*.parquet", "*.pq", "*.json"]
    files: list[str] = []
    for p in patterns:
        files += glob.glob(os.path.join(data_dir, "**", p), recursive=True)
    if not files:
        raise FileNotFoundError(f"No data files found under {data_dir}")

    frames = []
    for f in sorted(files):
        try:
            df = _read_any(f)
        except Exception as e:  # noqa: BLE001
            print(f"  ! skipping {f}: {e}")
            continue
        if df.empty:
            continue
        frames.append(df)
    if not frames:
        raise ValueError("No readable data files")

    raw = pd.concat(frames, ignore_index=True)
    cols = list(raw.columns)

    # coin filter
    coin_col = _find_col(cols, COIN_ALIASES)
    if coin_col is not None:
        mask = raw[coin_col].astype(str).str.upper().str.contains(coin.upper())
        if mask.any():
            raw = raw[mask]

    tcol = _find_col(cols, TIME_ALIASES)
    if tcol is None:
        raise ValueError(f"No timestamp column found among {cols}")

    out = pd.DataFrame()
    out["time"] = _parse_time(raw[tcol])
    for norm, aliases in COL_ALIASES.items():
        c = _find_col(cols, aliases)
        if c is not None:
            out[norm] = pd.to_numeric(raw[c], errors="coerce")
    if "close" not in out:
        raise ValueError(f"No close/price column found among {cols}")
    for c in ("open", "high", "low"):
        if c not in out:
            out[c] = out["close"]
    if "volume" not in out:
        out["volume"] = 0.0

    out = out.dropna(subset=["time", "close"]).sort_values("time")
    out = out.drop_duplicates(subset="time", keep="last").set_index("time")

    # native interval guess
    med = out.index.to_series().diff().median()
    secs = med.total_seconds() if pd.notna(med) else 86400
    if secs >= 86000:
        native = "1d"
    elif secs >= 3500:
        native = f"{round(secs / 3600)}h"
    else:
        native = f"{round(secs / 60)}m"

    agg: dict = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    for extra in ("funding", "open_interest"):
        if extra in out.columns:
            agg[extra] = "last"
    daily = out.resample("1D").agg(agg).dropna(subset=["close"])
    hourly = None
    if secs < 86000:
        hourly = out.resample("1h").agg(agg).dropna(subset=["close"])

    return Dataset(daily=daily, hourly=hourly, coin=coin, source_files=sorted(files), native_interval=native)
