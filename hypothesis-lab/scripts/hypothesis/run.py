"""Orchestrator: load data → run hypotheses → dual-AI verify → write JSON.

Usage:
  python run.py [--data ../../data] [--coin BTC] [--no-ai]

Output: lib/hypothesis/results.json (statically imported by the Next.js page).
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from loader import load  # noqa: E402
from engine import run_all  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "..", "..", "data"))
    ap.add_argument("--coin", default="BTC")
    ap.add_argument("--no-ai", action="store_true")
    ap.add_argument("--out", default=os.path.join(HERE, "..", "..", "lib", "hypothesis", "results.json"))
    args = ap.parse_args()

    print(f"Loading dataset from {os.path.abspath(args.data)} …")
    ds = load(args.data, coin=args.coin)
    print(f"  {ds.coin}: {ds.daily.index[0].date()} → {ds.daily.index[-1].date()} "
          f"({len(ds.daily)} daily bars, native {ds.native_interval})")

    print("Running hypotheses …")
    results = run_all(ds)
    for h in results["hypotheses"]:
        s = h["stats"]
        print(f"  {h['id']}: n={s['n']} hitRate={s['hitRate']} p={s['pValue']} → {s['verdict']}")

    if args.no_ai:
        for h in results["hypotheses"]:
            h["ai"] = {"claude": None, "openai": None, "agreement": "unverified"}
        print("Skipping AI verification (--no-ai)")
    else:
        print("Dual-AI verification (Claude + OpenAI) …")
        from ai_verify import verify  # noqa: E402
        results = verify(results)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"Wrote {os.path.abspath(args.out)}")


if __name__ == "__main__":
    main()
