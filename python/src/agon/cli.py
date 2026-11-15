"""Command line: `agon markets`, `agon search`, `agon market`, `agon quote`, `agon buy`, `agon sell`,
`agon positions`, `agon collect`, `agon balance`, `agon watch`."""

from __future__ import annotations

import argparse
import json
import sys

from .client import Delphi, DelphiError


def _out(obj, as_json: bool) -> None:
    if as_json:
        print(json.dumps(obj, indent=2, default=str))


def _market_line(m) -> str:
    odds = "  ".join(f"{o} {p:.0%}" for o, p in zip(m.outcomes, m.probabilities))
    close = m.trading_closes_at.strftime("%b %d %H:%M") if m.trading_closes_at else "?"
    return f"{m.address}  {close:>12}  ${m.pool_usd or 0:>7.2f}  {odds}\n    {m.question}"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="agon", description="Read and trade Delphi prediction markets. No API key needed.")
    p.add_argument("--network", default=None, help="mainnet (default), testnet or competition-testnet")
    p.add_argument("--json", action="store_true", help="print JSON")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("markets", help="list markets with live odds")
    s.add_argument("--status", default="open", help="open | awaiting_settlement | settled | expired | failed | all")
    s.add_argument("--limit", type=int, default=25)

    s = sub.add_parser("search", help="find markets by keywords")
    s.add_argument("query", nargs="+")
    s.add_argument("--status", default="open")
    s.add_argument("--limit", type=int, default=10)

    s = sub.add_parser("market", help="one market in full, with its rules and sources")
    s.add_argument("address")

    s = sub.add_parser("quote", help="price a buy or sell without sending anything")
    s.add_argument("address")
    s.add_argument("outcome", help='label ("Yes") or index')
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--usd", type=float, help="buy with this budget")
    g.add_argument("--shares", type=float, help="buy this many shares")
    g.add_argument("--sell", type=float, metavar="SHARES", help="sell this many shares")

    s = sub.add_parser("buy", help="buy shares (needs AGON_PRIVATE_KEY)")
    s.add_argument("address")
    s.add_argument("outcome")
    s.add_argument("--usd", type=float, required=True)
    s.add_argument("--max-slippage", type=float, default=0.02)
    s.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    s.add_argument("--record", action="store_true", help="record: seal --belief on Agon before buying")
    s.add_argument("--belief", type=float, help="your probability (0-1) that this outcome wins")
    s.add_argument("--reason", default=None, help="why, sealed with the belief")

    s = sub.add_parser("sell", help="sell shares (needs AGON_PRIVATE_KEY)")
    s.add_argument("address")
    s.add_argument("outcome")
    s.add_argument("--shares", type=float, default=None, help="default: all you hold")
    s.add_argument("--max-slippage", type=float, default=0.02)
    s.add_argument("--yes", action="store_true")

    s = sub.add_parser("positions", help="what a wallet holds and can collect")
    s.add_argument("wallet", nargs="?")

    s = sub.add_parser("collect", help="redeem a settled market or liquidate an expired/failed one")
    s.add_argument("address")

    sub.add_parser("balance", help="your wallet's USDC and gas")

    s = sub.add_parser("watch", help="alerts: new markets, big moves, closing soon, settlements, money to collect")
    s.add_argument("--every", type=float, default=60, help="seconds between checks")
    s.add_argument("--move", type=float, default=0.10, help="alert on probability moves of this size (0.10 = 10 points)")
    s.add_argument("--closing-hours", type=float, default=6)
    s.add_argument("--query", default="", help="only markets matching these words")
    s.add_argument("--market", action="append", default=[], help="only this market (repeatable)")
    s.add_argument("--wallet", default=None, help="also alert when this wallet can collect money")
    s.add_argument("--only", default="", help="comma list of alert kinds")
    s.add_argument("--webhook", default=None, help="POST each alert as JSON to this URL")
    s.add_argument("--telegram", action="store_true", help="send to TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID")
    s.add_argument("--once", action="store_true", help="check once and exit")

    a = p.parse_args(argv)
    import os
    record = getattr(a, "record", False) or os.environ.get("AGON_RECORD", "").lower() in ("1", "true", "yes")
    d = Delphi(a.network or os.environ.get("AGON_NETWORK", "mainnet"), record=record if a.cmd == "buy" else False)
    try:
        return _run(d, a)
    except (DelphiError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


def _confirm(text: str, yes: bool) -> bool:
    if yes:
        return True
    return input(f"{text} Type yes to send: ").strip().lower() == "yes"


def _run(d: Delphi, a) -> int:
    if a.cmd in ("markets", "search"):
        st = None if a.status == "all" else a.status
        ms = d.search(" ".join(a.query), status=st, limit=a.limit) if a.cmd == "search" else d.markets(status=st, limit=a.limit)
        if a.json:
            _out([{k: v for k, v in m.to_dict().items() if k != "raw_metadata"} for m in ms], True)
        else:
            for m in ms:
                print(_market_line(m))
            print(f"\n{len(ms)} market(s)")
        return 0
    if a.cmd == "market":
        m = d.market(a.address)
        if a.json:
            _out({k: v for k, v in m.to_dict().items() if k != "raw_metadata"}, True)
            return 0
        print(m.question, f"\n  status: {m.status}   type: {m.deployment}   pool: ${m.pool_usd:.2f}   fee: {m.trading_fee:.1%}")
        for o, pr in zip(m.outcomes, m.probabilities):
            print(f"  {o:<20} {pr:6.1%}")
        print(f"  trading closes: {m.trading_closes_at}   settle by: {m.settlement_deadline}")
        if m.rules:
            print(f"\nRules the judge applies:\n  {m.rules}")
        if m.sources:
            print("Sources:\n  " + "\n  ".join(m.sources))
        print(f"\nRules file matches on-chain hash: {m.metadata_verified}   judge: {m.judge_model}")
        print(m.url)
        return 0
    if a.cmd == "quote":
        q = d.quote_sell(a.address, a.outcome, a.sell) if a.sell is not None else d.quote_buy(a.address, a.outcome, usd=a.usd, shares=a.shares)
        if a.json:
            _out(q.to_dict(), True)
        else:
            after = f" → {q.probability_after:.1%}" if q.probability_after is not None else ""
            verb = "costs" if q.side == "buy" else "returns"
            print(f"{q.side} {q.shares:.4f} {q.outcome_label} shares {verb} ${q.usd:.4f} "
                  f"(avg {q.average_price:.4f}); probability {q.probability_before:.1%}{after}")
        return 0
    if a.cmd == "buy":
        q = d.quote_buy(a.address, a.outcome, usd=a.usd)
        if not _confirm(f"Buy {q.shares:.4f} {q.outcome_label} for ${q.usd:.2f} (max +{a.max_slippage:.0%})?", a.yes):
            return 1
        belief = {a.outcome: a.belief} if a.belief is not None else None
        t = d.buy(a.address, a.outcome, usd=a.usd, max_slippage=a.max_slippage, belief=belief, reasoning=a.reason)
        if a.json:
            _out(t.to_dict(), True)
        else:
            print(f"bought {t.shares:.4f} {t.outcome_label} for ${t.usd:.4f}\n{t.explorer_url}")
            if t.record and t.record.get("logged"):
                print(f"belief {t.record['belief']:.0%} vs market {t.record['market_probability']:.0%}, sealed until "
                      f"{t.record['sealed_until']}\nrecord: {t.record['record_url']}")
        return 0
    if a.cmd == "sell":
        if not _confirm(f"Sell {'all' if a.shares is None else a.shares} {a.outcome} shares?", a.yes):
            return 1
        t = d.sell(a.address, a.outcome, a.shares, max_slippage=a.max_slippage)
        _out(t.to_dict(), a.json) if a.json else print(f"sold {t.shares:.4f} {t.outcome_label} for ${t.usd:.4f}\n{t.explorer_url}")
        return 0
    if a.cmd == "positions":
        ps = d.positions(a.wallet)
        if a.json:
            _out([x.to_dict() for x in ps], True)
        else:
            for x in ps:
                v = f"${x.value_usd:.2f}" if x.value_usd is not None else "–"
                act = f"  → {x.action}" if x.action else ""
                print(f"{x.shares:10.4f} {x.outcome_label or x.outcome!s:<12} {v:>9}  {x.status:<19}{act}\n    {x.question}  {x.market}")
            print(f"\n{len(ps)} position(s)")
        return 0
    if a.cmd == "collect":
        m = d.market(a.address, with_rules=False)
        r = d.redeem(a.address) if m.status == "settled" else d.liquidate(a.address) if m.status in ("expired", "failed") else None
        if r is None:
            raise DelphiError(f"market is {m.status}; nothing to collect yet")
        _out(r, True) if a.json else print(f"collected ${r['usd']:.4f}\n{r['explorer_url']}")
        return 0
    if a.cmd == "balance":
        b = d.balance()
        _out(b, True) if a.json else print(f"{b['wallet']}: ${b['usd']:.2f} USDC, {b['eth']:.6f} ETH for gas")
        return 0
    if a.cmd == "watch":
        from .watch import WatchConfig, Watcher, print_sink, telegram_sink, webhook_sink
        cfg = WatchConfig(move=a.move, closing_hours=a.closing_hours, query=a.query,
                          markets=frozenset(x.lower() for x in a.market), wallet=a.wallet,
                          kinds=frozenset(k.strip() for k in a.only.split(",") if k.strip()))
        sinks = [print_sink(a.json)]
        if a.webhook:
            sinks.append(webhook_sink(a.webhook))
        if a.telegram:
            sinks.append(telegram_sink())
        w = Watcher(d, cfg)
        if not w.state:
            print("first run: recording a baseline; alerts start from the next check", file=sys.stderr)
        w.run(a.every, sinks, once=a.once)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
