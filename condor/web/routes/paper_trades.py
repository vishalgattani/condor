from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends

from condor.web.auth import get_current_user
from condor.web.models import WebUser

router = APIRouter(tags=["paper-trades"])


def _instances_dir() -> Path:
    """Resolve hummingbot-api bot instances directory.

    Override with HUMMINGBOT_INSTANCES_DIR env var.
    Default: sibling hummingbot-api directory (standard local setup).
    """
    env = os.environ.get("HUMMINGBOT_INSTANCES_DIR", "").strip()
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[5] / "hummingbot-api" / "bots" / "instances"


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


@router.get("/paper-trades")
async def list_paper_trades(user: WebUser = Depends(get_current_user)):
    """Return paper trade history for all bots that have a paper_trades.json."""
    instances = _instances_dir()
    result = []
    if not instances.is_dir():
        return result

    for bot_dir in sorted(instances.iterdir()):
        if not bot_dir.is_dir():
            continue
        log = bot_dir / "data" / "paper_trades.json"
        if not log.exists():
            continue
        try:
            trades = json.loads(log.read_text())
        except Exception:
            continue
        result.append({
            "bot_name": bot_dir.name,
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
