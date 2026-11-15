"""Spending limits for agents. Every trade made through the MCP server (or any code that uses ``Guard``) is
checked against a per-trade cap, a rolling daily cap and an optional market allow-list, and recorded in a small
ledger file so the daily cap survives restarts."""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


class LimitExceeded(Exception):
    pass


def _env_float(name: str, default: float) -> float:
    v = os.environ.get(name)
    return float(v) if v not in (None, "") else default


@dataclass
class Limits:
    trading_enabled: bool = False
    max_trade_usd: float = 5.0
    max_daily_usd: float = 20.0
    max_slippage: float = 0.03
    allowed_markets: frozenset[str] | None = None

    @classmethod
    def from_env(cls) -> "Limits":
        allow = os.environ.get("AGON_ALLOWED_MARKETS")
        return cls(
            trading_enabled=os.environ.get("AGON_ALLOW_TRADING", "").lower() in ("1", "true", "yes"),
            max_trade_usd=_env_float("AGON_MAX_TRADE_USD", 5.0),
            max_daily_usd=_env_float("AGON_MAX_DAILY_USD", 20.0),
            max_slippage=_env_float("AGON_MAX_SLIPPAGE", 0.03),
            allowed_markets=frozenset(a.strip().lower() for a in allow.split(",") if a.strip()) if allow else None,
        )


class Guard:
    def __init__(self, limits: Limits, ledger: Path | None = None):
        self.limits = limits
        base = Path(os.environ.get("AGON_CACHE") or Path.home() / ".cache" / "agon")
        base.mkdir(parents=True, exist_ok=True)
        self.ledger = ledger or base / "spend.json"
        self._lock = threading.Lock()

    def _today(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def _read(self) -> dict:
        try:
            return json.loads(self.ledger.read_text())
        except (FileNotFoundError, ValueError):
            return {}

    def spent_today(self) -> float:
        return float(self._read().get(self._today(), 0.0))

    def check(self, market: str, usd: float) -> None:
        lim = self.limits
        if not lim.trading_enabled:
            raise LimitExceeded("trading is off. Set AGON_ALLOW_TRADING=true to let this agent trade.")
        if lim.allowed_markets is not None and market.lower() not in lim.allowed_markets:
            raise LimitExceeded("this market is not in AGON_ALLOWED_MARKETS")
        if usd > lim.max_trade_usd + 1e-9:
            raise LimitExceeded(f"${usd:.2f} is over the per-trade limit of ${lim.max_trade_usd:.2f} (AGON_MAX_TRADE_USD)")
        left = lim.max_daily_usd - self.spent_today()
        if usd > left + 1e-9:
            raise LimitExceeded(f"${usd:.2f} is over today's remaining budget of ${max(0.0, left):.2f} (AGON_MAX_DAILY_USD)")

    def record(self, usd: float) -> None:
        with self._lock:
            data = self._read()
            day = self._today()
            data[day] = round(float(data.get(day, 0.0)) + usd, 6)
            data = {k: v for k, v in data.items() if k >= sorted(data)[-30:][0]}  # keep 30 days
            self.ledger.write_text(json.dumps(data, indent=1))

    def status(self) -> dict:
        lim = self.limits
        return {
            "trading_enabled": lim.trading_enabled,
            "max_trade_usd": lim.max_trade_usd,
            "max_daily_usd": lim.max_daily_usd,
            "spent_today_usd": round(self.spent_today(), 4),
            "max_slippage": lim.max_slippage,
            "allowed_markets": sorted(lim.allowed_markets) if lim.allowed_markets is not None else "all",
        }
