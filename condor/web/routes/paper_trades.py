from __future__ import annotations

import json
import math
import os
import subprocess
from pathlib import Path
from typing import Any

import aiohttp
import pandas as pd
from fastapi import APIRouter, Depends, Query

from condor.web.auth import get_current_user
from condor.web.models import WebUser

# Kraken public OHLC interval in minutes
_KRAKEN_INTERVAL: dict[str, int] = {
    "1m": 1, "5m": 5, "15m": 15, "30m": 30,
    "1h": 60, "4h": 240, "1d": 1440,
}

router = APIRouter(tags=["paper-trades"])


def _instances_dir() -> Path:
    """Resolve hummingbot-api bot instances directory.

    Override with HUMMINGBOT_INSTANCES_DIR env var.
    Default: sibling hummingbot-api directory (standard local setup).
    """
    env = os.environ.get("HUMMINGBOT_INSTANCES_DIR", "").strip()
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[4] / "hummingbot-api" / "bots" / "instances"


def _summarize(trades: list[dict]) -> dict[str, Any]:
    sells = [t for t in trades if t.get("side") == "SELL"]
    buys  = [t for t in trades if t.get("side") == "BUY"]
    total_pnl = sum(t.get("pnl_usd", 0) for t in sells)
    wins = sum(1 for t in sells if t.get("pnl_usd", 0) > 0)
    open_trade = next(
        (t for t in reversed(trades)
         if t["side"] == "BUY" and not any(s["trade_num"] == t["trade_num"] for s in sells)),
        None,
    )
    return {
        "closed_trades": len(sells),
        "open_trade": open_trade,
        "total_pnl": round(total_pnl, 4),
        "wins": wins,
        "losses": len(sells) - wins,
        "win_rate": round(wins / len(sells) * 100, 1) if sells else 0.0,
        "avg_win": round(
            sum(t["pnl_usd"] for t in sells if t["pnl_usd"] > 0) / wins, 4
        ) if wins else 0.0,
        "avg_loss": round(
            sum(t["pnl_usd"] for t in sells if t["pnl_usd"] <= 0) / max(len(sells) - wins, 1), 4
        ) if sells else 0.0,
        "buy_count": len(buys),
    }


def _is_paper_bot(bot_dir: Path) -> bool:
    """True if this instance was deployed with a paper trade script config."""
    scripts_conf = bot_dir / "conf" / "scripts"
    if not scripts_conf.is_dir():
        return False
    return any("paper" in f.name for f in scripts_conf.iterdir())


def _running_containers() -> set[str]:
    """Return names of currently running Docker containers."""
    try:
        out = subprocess.check_output(
            ["docker", "ps", "--format", "{{.Names}}"], timeout=5
        )
        return {n.strip() for n in out.decode().splitlines() if n.strip()}
    except Exception:
        return set()


@router.get("/paper-trades")
async def list_paper_trades(user: WebUser = Depends(get_current_user)):
    """Return paper trade bots that are currently running OR have trade history.

    Stopped instances with no trades are hidden — they're just old debugging runs.
    """
    instances = _instances_dir()
    result = []
    if not instances.is_dir():
        return result

    running = _running_containers()

    for bot_dir in sorted(instances.iterdir(), reverse=True):
        if not bot_dir.is_dir():
            continue
        if not _is_paper_bot(bot_dir):
            continue

        is_running = bot_dir.name in running
        log = bot_dir / "data" / "paper_trades.json"
        has_trades = log.exists()

        # Skip stopped bots with no trade history — they're abandoned runs
        if not is_running and not has_trades:
            continue

        trades: list[dict] = []
        if has_trades:
            try:
                trades = json.loads(log.read_text())
            except Exception:
                pass

        result.append({
            "bot_name": bot_dir.name,
            "running": is_running,
            "summary": _summarize(trades),
            "trades": trades,
        })

    return result


@router.get("/paper-trades/{bot_name}")
async def get_paper_trades(bot_name: str, user: WebUser = Depends(get_current_user)):
    """Return paper trade history for a specific bot."""
    log = _instances_dir() / bot_name / "data" / "paper_trades.json"
    if not log.exists():
        return {"bot_name": bot_name, "summary": None, "trades": []}
    try:
        trades = json.loads(log.read_text())
    except Exception:
        return {"bot_name": bot_name, "summary": None, "trades": []}
    return {
        "bot_name": bot_name,
        "summary": _summarize(trades),
        "trades": trades,
    }


@router.get("/indicators")
async def get_indicators(
    pair: str = Query(default="ETH-USD"),
    interval: str = Query(default="5m"),
    limit: int = Query(default=60, ge=10, le=200),
    user: WebUser = Depends(get_current_user),
):
    """Fetch OHLC from Kraken, compute RSI(14) + EMA(9/21), return candle series."""
    kraken_interval = _KRAKEN_INTERVAL.get(interval, 5)
    kraken_pair = pair.replace("-", "")
    url = (
        f"https://api.kraken.com/0/public/OHLC"
        f"?pair={kraken_pair}&interval={kraken_interval}"
    )
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json()
    except Exception as e:
        return {"error": str(e), "candles": []}

    if data.get("error"):
        return {"error": data["error"], "candles": []}

    result = data["result"]
    key = next(k for k in result if k != "last")
    rows = result[key][-limit:]

    df = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close", "vwap", "volume", "count"])
    for col in ("open", "high", "low", "close"):
        df[col] = df[col].astype(float)

    # RSI(14) via Wilder smoothing
    delta = df["close"].diff()
    gain = delta.clip(lower=0).ewm(com=13, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(com=13, adjust=False).mean()
    df["rsi"] = (100 - 100 / (1 + gain / loss.replace(0, float("nan")))).round(2)

    # EMA(9) and EMA(21)
    df["ema_fast"] = df["close"].ewm(span=9, adjust=False).mean().round(4)
    df["ema_slow"] = df["close"].ewm(span=21, adjust=False).mean().round(4)

    raw = df[["time", "open", "high", "low", "close", "rsi", "ema_fast", "ema_slow"]].to_dict(orient="records")
    candles = [
        {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in row.items()}
        for row in raw
    ]
    return {"pair": pair, "interval": interval, "candles": candles}


@router.get("/paper-trades/{bot_name}/logs")
async def get_bot_logs(
    bot_name: str,
    lines: int = Query(default=100, ge=1, le=2000),
    user: WebUser = Depends(get_current_user),
):
    """Return the last N lines from a bot's log file."""
    log_file = _instances_dir() / bot_name / "logs" / "logs_hummingbot.log"
    if not log_file.exists():
        return {"bot_name": bot_name, "lines": []}
    try:
        # Read last `lines` lines efficiently without loading full file
        content = log_file.read_bytes()
        raw_lines = content.split(b"\n")
        tail = [l.decode("utf-8", errors="replace") for l in raw_lines[-lines - 1:] if l]
        return {"bot_name": bot_name, "lines": tail}
    except Exception:
        return {"bot_name": bot_name, "lines": []}
