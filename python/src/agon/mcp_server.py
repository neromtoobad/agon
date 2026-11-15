"""An MCP server that lets any AI agent (Claude, Cursor, Hermes, your own) read and trade Delphi markets.

Reading needs nothing. Trading is off until you set ``AGON_ALLOW_TRADING=true`` and a wallet key, and every
trade is held to a per-trade cap, a daily cap and a slippage cap (see ``limits.py``).

    uvx --from "agon-delphi[mcp]" agon-mcp        # stdio, for Claude Desktop / Claude Code / Cursor
"""

from __future__ import annotations

import os
from typing import Any, Optional

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from . import __version__

from .client import Delphi, DelphiError
from .limits import Guard, LimitExceeded, Limits

INSTRUCTIONS = """Delphi is a prediction market on the Gensyn chain, settled by an AI judge that reads each
market's rules and named sources. Prices are probabilities (0-1). Before buying: read the market's rules and
sources with get_market, quote with quote_buy, and check probability_after: thin markets move a lot on small
trades. Trades are held to spending limits shown by wallet_status; never try to work around them.
If wallet_status shows recording is on, every buy must state your honest probability for the outcome
you buy and a short reason. It is sealed until trading closes and scored against the market when it settles, so
state what you actually believe, not what justifies the trade."""

READ = ToolAnnotations(read_only_hint=True, open_world_hint=True)
WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=True)

server = MCPServer(name="agon", instructions=INSTRUCTIONS, version=__version__)
_client: Optional[Delphi] = None
_guard: Optional[Guard] = None


def client() -> Delphi:
    global _client
    if _client is None:
        rec = os.environ.get("AGON_RECORD", "").lower()
        _client = Delphi(os.environ.get("AGON_NETWORK", "mainnet"),
                         record="try" if rec == "try" else rec in ("1", "true", "yes"),
                         agent_name=os.environ.get("AGON_AGENT_NAME"), agent_model=os.environ.get("AGON_AGENT_MODEL", ""))
    return _client


def guard() -> Guard:
    global _guard
    if _guard is None:
        _guard = Guard(Limits.from_env())
    return _guard


def _brief(m) -> dict:
    return {
        "address": m.address, "question": m.question, "status": m.status,
        "outcomes": [{"label": o, "probability": round(p, 4)} for o, p in zip(m.outcomes, m.probabilities)],
        "trading_closes_at": m.trading_closes_at.isoformat() if m.trading_closes_at else None,
        "pool_usd": round(m.pool_usd or 0, 2), "type": m.deployment,
    }


def _fail(e: Exception) -> dict:
    """Report a failure as a tool error, so the client and the model both see that the call did not work."""
    raise ToolError(str(e)) from None


@server.tool(annotations=READ)
def list_markets(status: str = "open", query: str = "", limit: int = 20) -> Any:
    """List Delphi markets with live probabilities. status: open | awaiting_settlement | settled | expired | failed | all.
    query: optional keywords to search questions, outcomes and rules. Open markets come soonest-closing first."""
    try:
        st = None if status == "all" else status
        ms = client().search(query, status=st, limit=limit) if query.strip() else client().markets(status=st, limit=limit)
        return [_brief(m) for m in ms]
    except (DelphiError, ValueError) as e:
        return _fail(e)


@server.tool(annotations=READ)
def get_market(market: str) -> Any:
    """Everything about one market: question, outcomes and probabilities, the rules the AI judge will apply,
    its sources, deadlines, pool size, fee, and whether the rules file matches its on-chain hash."""
    try:
        m = client().market(market)
        d = m.to_dict()
        d.pop("raw_metadata", None)
        return d
    except (DelphiError, ValueError) as e:
        return _fail(e)


@server.tool(annotations=READ)
def quote_buy(market: str, outcome: str, usd: float) -> Any:
    """What spending `usd` on `outcome` (label like "Yes" or an index) buys right now: shares, average price,
    and the probability after the trade. Fees included; nothing is sent."""
    try:
        return client().quote_buy(market, outcome, usd=usd).to_dict()
    except (DelphiError, ValueError) as e:
        return _fail(e)


@server.tool(annotations=READ)
def quote_sell(market: str, outcome: str, shares: float) -> Any:
    """What selling `shares` of `outcome` back to the market returns right now. Nothing is sent."""
    try:
        return client().quote_sell(market, outcome, shares).to_dict()
    except (DelphiError, ValueError) as e:
        return _fail(e)


@server.tool(annotations=READ)
def get_positions(wallet: str = "") -> Any:
    """Shares a wallet holds across every Delphi market, their current value, and what can be collected
    (redeem after settlement, liquidate after a failed or expired market). Defaults to the agent's own wallet."""
    try:
        return [p.to_dict() for p in client().positions(wallet or None)]
    except (DelphiError, ValueError) as e:
        return _fail(e)


@server.tool(annotations=READ)
def wallet_status() -> Any:
    """The agent's wallet address, USDC and gas balance, and its spending limits and spend so far today."""
    c = client()
    out: dict[str, Any] = {"network": c.network.name, "limits": guard().status(),
                           "recording": {"on": True, "mode": c.record_mode, "agent": c.recorder.name,
                                               "record_url": c.recorder.agent_url} if c.recorder else {"on": False}}
    if c.address:
        try:
            out.update(c.balance())
        except Exception as e:  # noqa: BLE001
            out["balance_error"] = str(e)
    else:
        out["wallet"] = None
        out["note"] = "Read-only: no AGON_PRIVATE_KEY set."
    return out


@server.tool(annotations=WRITE)
def buy(market: str, outcome: str, usd: float, probability: float = -1, reasoning: str = "") -> Any:
    """Buy shares of `outcome` with up to `usd` of USDC. Held to the per-trade, daily and slippage limits.
    Quote first and read the rules; this sends a real transaction.
    probability: your honest probability (0-1) that `outcome` wins. Required when recording is on;
    it is sealed with `reasoning` before the trade and scored after the market settles."""
    g = guard()
    try:
        g.check(market, usd)
        c = client()
        belief = None
        if c.recorder:
            if not 0 < probability < 1:
                raise ValueError("recording is on: pass probability, your honest chance (0-1) that this outcome wins")
            belief = {outcome: probability}
        t = c.buy(market, outcome, usd=usd, max_slippage=g.limits.max_slippage, belief=belief, reasoning=reasoning or None)
        g.record(t.usd)
        return t.to_dict()
    except (LimitExceeded, DelphiError, ValueError) as e:
        return _fail(e)


@server.tool(annotations=WRITE)
def sell(market: str, outcome: str, shares: float = 0) -> Any:
    """Sell `shares` of `outcome` back to the market (0 = everything held). Sends a real transaction."""
    g = guard()
    try:
        if not g.limits.trading_enabled:
            raise LimitExceeded("trading is off. Set AGON_ALLOW_TRADING=true to let this agent trade.")
        return client().sell(market, outcome, shares or None, max_slippage=g.limits.max_slippage).to_dict()
    except (LimitExceeded, DelphiError, ValueError) as e:
        return _fail(e)


@server.tool(annotations=WRITE)
def collect(market: str) -> Any:
    """Collect what a closed market owes the agent: redeems winnings from a settled market, or liquidates
    shares in an expired or failed market at their final prices."""
    g = guard()
    try:
        if not g.limits.trading_enabled:
            raise LimitExceeded("trading is off. Set AGON_ALLOW_TRADING=true to let this agent trade.")
        c = client()
        m = c.market(market, with_rules=False)
        if m.status == "settled":
            return c.redeem(market)
        if m.status in ("expired", "failed"):
            return c.liquidate(market)
        return _fail(DelphiError(f"market is {m.status}; nothing to collect yet"))
    except (LimitExceeded, DelphiError, ValueError) as e:
        return _fail(e)


@server.tool(annotations=READ)
def my_record() -> Any:
    """The agent's record: every sealed belief it logged before trading, and once markets settle, how its
    probabilities scored against the market's. Sealed entries show no numbers until trading closes."""
    c = client()
    if not c.recorder:
        return {"on": False, "note": "Recording is off. Set AGON_RECORD=true to turn it on."}
    try:
        return {"record_url": c.recorder.agent_url, **c.recorder.record()}
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def main() -> None:
    server.run("stdio")


if __name__ == "__main__":
    main()
