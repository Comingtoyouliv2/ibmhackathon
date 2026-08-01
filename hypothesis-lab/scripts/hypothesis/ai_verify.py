"""Dual-AI verification: Claude + OpenAI read the SAME computed stats and
independently produce a verdict. Agreement/disagreement is surfaced in the UI
as a hallucination cross-check. The AIs never see each other's answers and
never produce numbers — all figures come from engine.py.

Keys are read from ../../.env.local (ANTHROPIC_API_KEY, OPENAI_API_KEY).
"""

from __future__ import annotations

import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

CLAUDE_MODEL = "claude-sonnet-4-5"
OPENAI_MODEL = "gpt-4o"

PROMPT = """You are auditing a crypto market hypothesis backtest. Below are the
mechanically computed statistics (pandas over 3 years of Hyperliquid BTC data).
Do NOT invent numbers. Judge only from the given stats.

Hypothesis: {question}
Method: {method}
Stats: {stats}
Cases (sample): {cases}

Respond with ONLY valid JSON, no markdown fences:
{{"verdict": "supported" | "weak" | "rejected" | "inconclusive",
  "confidence": "high" | "medium" | "low",
  "commentary_ko": "<2-3 sentence Korean interpretation. Mention sample size limits and any caveat (e.g. small n, regime dependence). Plain language for retail traders.>"}}"""


def load_env() -> dict[str, str]:
    env = dict(os.environ)
    path = os.path.join(HERE, "..", "..", ".env.local")
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env


def _post(url: str, headers: dict, body: dict, timeout: int = 120) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _parse(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`").lstrip("json").strip()
    start, end = text.find("{"), text.rfind("}")
    return json.loads(text[start : end + 1])


def ask_claude(prompt: str, key: str) -> dict:
    out = _post(
        "https://api.anthropic.com/v1/messages",
        {"x-api-key": key, "anthropic-version": "2023-06-01"},
        {"model": CLAUDE_MODEL, "max_tokens": 600, "messages": [{"role": "user", "content": prompt}]},
    )
    return {**_parse(out["content"][0]["text"]), "model": CLAUDE_MODEL}


def ask_openai(prompt: str, key: str) -> dict:
    out = _post(
        "https://api.openai.com/v1/chat/completions",
        {"Authorization": f"Bearer {key}"},
        {"model": OPENAI_MODEL, "max_tokens": 600, "temperature": 0.2,
         "messages": [{"role": "user", "content": prompt}]},
    )
    return {**_parse(out["choices"][0]["message"]["content"]), "model": OPENAI_MODEL}


def agreement(a: dict | None, b: dict | None) -> str:
    if not a or not b:
        return "unverified"
    va, vb = a.get("verdict"), b.get("verdict")
    if va == vb:
        return "agree"
    soft = {("supported", "weak"), ("weak", "supported"), ("rejected", "inconclusive"), ("inconclusive", "rejected"),
            ("weak", "inconclusive"), ("inconclusive", "weak")}
    return "partial" if (va, vb) in soft else "disagree"


def verify(results: dict) -> dict:
    env = load_env()
    akey, okey = env.get("ANTHROPIC_API_KEY"), env.get("OPENAI_API_KEY")
    for h in results["hypotheses"]:
        prompt = PROMPT.format(
            question=h["questionEn"] + " / " + h["question"],
            method=h["method"],
            stats=json.dumps(h["stats"], ensure_ascii=False),
            cases=json.dumps(h["cases"][:20], ensure_ascii=False),
        )
        claude = openai = None
        if akey:
            try:
                claude = ask_claude(prompt, akey)
            except Exception as e:  # noqa: BLE001
                print(f"  ! claude failed for {h['id']}: {e}")
        if okey:
            try:
                openai = ask_openai(prompt, okey)
            except Exception as e:  # noqa: BLE001
                print(f"  ! openai failed for {h['id']}: {e}")
        h["ai"] = {"claude": claude, "openai": openai, "agreement": agreement(claude, openai)}
        print(f"  {h['id']}: engine={h['stats']['verdict']} claude={claude and claude.get('verdict')} openai={openai and openai.get('verdict')} → {h['ai']['agreement']}")
    return results
