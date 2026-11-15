"""Alerts for Delphi. Delphi has no notifications, webhooks or websocket, so this polls the chain and reports:

- new markets
- big moves in a market's probabilities
- markets about to close
- markets that close, settle (with the winner), fail or expire
- money a wallet can now collect

Alerts go to the terminal, as JSON lines, to a webhook, or to a Telegram chat.
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Optional

import httpx

from .chain import Call
from .client import Delphi, _cache_dir
from .models import STATUSES, Market
from .search import rank


@dataclass
class Alert:
    kind: str            # new_market | move | closing_soon | closed | settled | failed | expired | claimable
    market: str
    question: Optional[str]
    text: str
    data: dict = field(default_factory=dict)
    at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return {"kind": self.kind, "market": self.market, "question": self.question, "text": self.text,
                "data": self.data, "at": self.at}


@dataclass
class WatchConfig:
    move: float = 0.10                  # alert when an outcome moves this much (absolute) since the last alert
    closing_hours: float = 6.0          # alert once when an open market is this close to closing
    query: str = ""                     # only markets matching these words (empty = all)
    markets: frozenset[str] = frozenset()  # only these markets (empty = all)
    wallet: Optional[str] = None        # also alert when this wallet has something to collect
    kinds: frozenset[str] = frozenset()  # only these alert kinds (empty = all)


class Watcher:
    def __init__(self, delphi: Delphi, config: WatchConfig, state_file: Path | None = None):
        self.d = delphi
        self.cfg = config
        name = f"watch-{delphi.network.name}.json"
        self.state_file = state_file or _cache_dir() / name
        self.state = self._load()

    def _load(self) -> dict:
        try:
            return json.loads(self.state_file.read_text())
        except (FileNotFoundError, ValueError):
            return {}

    def _save(self) -> None:
        self.state_file.write_text(json.dumps(self.state))

    def _wanted(self, m: Market) -> bool:
        if self.cfg.markets and m.address.lower() not in self.cfg.markets:
            return False
        if self.cfg.query.strip() and not rank([m], self.cfg.query):
            return False
        return True

    def poll(self) -> list[Alert]:
        """One pass over the chain. The first pass only records a baseline and returns no alerts."""
        d, st = self.d, self.state
        first = not st
        seen: dict = st.setdefault("status", {})
        base: dict = st.setdefault("base", {})
        warned: list = st.setdefault("closing_warned", [])
        alerts: list[Alert] = []

        addrs = d.market_addresses()
        statuses = d.reader.run([Call(d._gw[d._where[a.lower()]], "marketStatus", [a]) for a in addrs])
        now_status = {a: STATUSES[s] for a, s in zip(addrs, statuses) if isinstance(s, int)}

        live = [a for a, s in now_status.items() if s == "open"]
        if first:  # baseline: remember every status, only load the open markets
            seen.update({a.lower(): s for a, s in now_status.items()})
            changed: list[str] = []
        else:
            changed = [a for a, s in now_status.items() if seen.get(a.lower()) != s]
        load = list(dict.fromkeys(live + changed))
        markets = {m.address.lower(): m for m in d._load(load, with_rules=True)} if load else {}

        for a in changed:
            key, s = a.lower(), now_status[a]
            m = markets.get(key)
            prev = seen.get(key)
            seen[key] = s
            if first or m is None or not self._wanted(m):
                continue
            if prev is None:
                if s == "open":
                    odds = ", ".join(f"{o} {p:.0%}" for o, p in zip(m.outcomes, m.probabilities))
                    alerts.append(Alert("new_market", m.address, m.question, f"New market: {m.question} [{odds}]",
                                        {"outcomes": m.outcomes, "probabilities": m.probabilities}))
                continue
            if s == "awaiting_settlement":
                alerts.append(Alert("closed", m.address, m.question, f"Trading closed: {m.question}"))
            elif s == "settled":
                win = m.outcomes[m.winning_outcome] if m.winning_outcome is not None and m.winning_outcome < len(m.outcomes) else "?"
                alerts.append(Alert("settled", m.address, m.question, f"Settled: {m.question} → {win}",
                                    {"winning_outcome": m.winning_outcome, "winning_label": win}))
            elif s in ("failed", "expired"):
                alerts.append(Alert(s, m.address, m.question,
                                    f"{s.capitalize()} with no winner: {m.question}. Holders can liquidate at final prices."))

        now = time.time()
        for a in live:
            m = markets.get(a.lower())
            if m is None or not self._wanted(m) or not m.probabilities:
                continue
            key = a.lower()
            ref = base.get(key)
            if ref is None or len(ref) != len(m.probabilities):
                base[key] = m.probabilities
            else:
                moves = [p - r for p, r in zip(m.probabilities, ref)]
                j = max(range(len(moves)), key=lambda i: abs(moves[i]))
                if abs(moves[j]) >= self.cfg.move:
                    base[key] = m.probabilities
                    if not first:
                        label = m.outcomes[j] if j < len(m.outcomes) else f"outcome {j}"
                        alerts.append(Alert("move", m.address, m.question,
                                            f"{label} {ref[j]:.0%} → {m.probabilities[j]:.0%}: {m.question}",
                                            {"outcome": j, "from": ref[j], "to": m.probabilities[j]}))
            close = m.trading_closes_at.timestamp() if m.trading_closes_at else None
            if close and 0 < close - now <= self.cfg.closing_hours * 3600 and key not in warned:
                warned.append(key)
                if not first:
                    hrs = (close - now) / 3600
                    alerts.append(Alert("closing_soon", m.address, m.question,
                                        f"Closes in {hrs:.1f} h: {m.question}", {"closes_at": m.trading_closes_at.isoformat()}))

        if self.cfg.wallet:
            have = set(st.setdefault("claimable", []))
            for p in self.d.positions(self.cfg.wallet):
                if p.action and f"{p.market}:{p.outcome}" not in have:
                    have.add(f"{p.market}:{p.outcome}")
                    if not first:
                        amount = f" ${p.claimable_usd:.2f}" if p.claimable_usd else ""
                        alerts.append(Alert("claimable", p.market, p.question,
                                            f"You can {p.action}{amount}: {p.question}", p.to_dict()))
            st["claimable"] = sorted(have)

        st["closing_warned"] = warned[-2000:]
        self._save()
        if self.cfg.kinds:
            alerts = [a for a in alerts if a.kind in self.cfg.kinds]
        return alerts

    def run(self, every: float, sinks: Iterable[Callable[[Alert], None]], once: bool = False) -> None:
        sinks = list(sinks)
        while True:
            try:
                for a in self.poll():
                    for s in sinks:
                        try:
                            s(a)
                        except Exception as e:  # noqa: BLE001
                            print(f"alert delivery failed: {e}", file=sys.stderr)
            except Exception as e:  # noqa: BLE001  (RPC hiccup: try again next round)
                print(f"poll failed: {e}", file=sys.stderr)
            if once:
                return
            time.sleep(every)


# ------------------------------------------------------------------ sinks

def print_sink(json_lines: bool = False) -> Callable[[Alert], None]:
    def f(a: Alert) -> None:
        print(json.dumps(a.to_dict()) if json_lines else f"[{a.kind}] {a.text}  {a.market}", flush=True)
    return f


def webhook_sink(url: str) -> Callable[[Alert], None]:
    http = httpx.Client(timeout=15)

    def f(a: Alert) -> None:
        http.post(url, json=a.to_dict()).raise_for_status()
    return f


def telegram_sink(token: str | None = None, chat_id: str | None = None) -> Callable[[Alert], None]:
    token = token or os.environ["TELEGRAM_BOT_TOKEN"]
    chat_id = chat_id or os.environ["TELEGRAM_CHAT_ID"]
    http = httpx.Client(timeout=15)

    def f(a: Alert) -> None:
        http.post(f"https://api.telegram.org/bot{token}/sendMessage",
                  json={"chat_id": chat_id, "text": a.text, "disable_web_page_preview": True}).raise_for_status()
    return f
