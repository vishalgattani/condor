from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Query

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
