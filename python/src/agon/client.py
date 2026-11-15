"""The Delphi client: read every market straight from the chain, quote, trade, and track positions.

No API key is needed. Every number comes from the Gensyn chain through a public RPC, and each market's rules
file is checked against the hash stored on chain.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Iterable, Optional

import httpx
from eth_account import Account
from web3 import Web3

from .chain import ERC20_ABI, Call, Reader, abi, checksum, connect
from .models import STATUSES, Market, Position, Quote, Trade, ts
from .networks import Deployment, Network, get_network

SHARE = 10**18
MAX_UINT = 2**256 - 1


FINAL_STATUSES = ("settled", "expired", "failed")


class DelphiError(Exception):
    pass


class InsufficientFunds(DelphiError):
    pass


def _cache_dir() -> Path:
    base = os.environ.get("AGON_CACHE") or os.path.join(os.path.expanduser("~"), ".cache", "agon")
    p = Path(base)
    p.mkdir(parents=True, exist_ok=True)
    return p


class Delphi:
    """Read and trade Delphi prediction markets.

    >>> d = Delphi()                                   # mainnet, read-only
    >>> for m in d.markets(status="open")[:5]: print(m.summary())
    >>> d.quote_buy(m.address, "Yes", usd=5)

    Pass ``private_key`` (or set ``AGON_PRIVATE_KEY``) to trade.
    """

    def __init__(self, network: str | Network = "mainnet", *, private_key: str | None = None,
                 rpc_url: str | None = None, cache: bool = True, record: bool | str = False,
                 recorder_url: str | None = None, agent_name: str | None = None, agent_model: str = ""):
        """``record=True`` turns on recording: every buy must state what the agent believes, and that
        belief is sealed and anchored on chain (via Agon) before the trade is sent. No entry, no trade.
        ``record="try"`` trades even if the entry can't be logged, and says why on the Trade."""
        self.network = network if isinstance(network, Network) else get_network(network)
        self.w3 = connect(self.network, rpc_url or os.environ.get("AGON_RPC_URL"))
        self.reader = Reader(self.w3, self.network)
        key = private_key or os.environ.get("AGON_PRIVATE_KEY")
        self.account = Account.from_key(key) if key else None
        self.cache = cache
        self.token = self.w3.eth.contract(address=checksum(self.network.token), abi=ERC20_ABI)
        self._dep = {d.name: d for d in self.network.deployments}
        self._gw = {d.name: self.w3.eth.contract(address=checksum(d.gateway), abi=abi(d.kind)) for d in self.network.deployments}
        self._fac = {d.name: self.w3.eth.contract(address=checksum(d.factory), abi=abi("factory")) for d in self.network.deployments}
        self._where: dict[str, str] = {}            # market (lowercase) -> deployment name
        self._addresses: dict[str, list[str]] = {}  # deployment name -> market addresses, oldest first
        self._meta: dict[str, tuple[Optional[dict], Optional[bool]]] = {}
        self._http = httpx.Client(timeout=20, follow_redirects=True, headers={"User-Agent": "agon"})
        self.recorder = None
        self.record_mode = "off"
        if record:
            if not self.account:
                raise DelphiError("record=True needs a wallet key: entries are signed by the trading wallet")
            if self.network.name != "mainnet":
                raise DelphiError("recording covers mainnet markets only")
            from .recorder import Recorder
            self.recorder = Recorder(key, url=recorder_url, name=agent_name, model=agent_model, chain_id=self.network.chain_id)
            self.record_mode = "try" if record == "try" else "required"

    # ------------------------------------------------------------------ wallet

    @property
    def address(self) -> Optional[str]:
        return self.account.address if self.account else None

    def balance(self, wallet: str | None = None) -> dict:
        """USDC and gas (ETH) held by a wallet."""
        w = checksum(wallet or self._need_account().address)
        return {
            "wallet": w,
            "usd": self.token.functions.balanceOf(w).call() / 10**self.network.token_decimals,
            "eth": self.w3.eth.get_balance(w) / 1e18,
        }

    # ---------------------------------------------------------------- routing

    def _deployment(self, market: str) -> Deployment:
        key = market.lower()
        if key not in self._where:
            calls = [Call(self._fac[n], "marketProxyExists", [checksum(market)]) for n in self._dep]
            for name, found in zip(self._dep, self.reader.run(calls)):
                if found is True:
                    self._where[key] = name
                    break
            else:
                raise DelphiError(f"{market} is not a Delphi market on {self.network.name}")
        return self._dep[self._where[key]]

    def gateway_for(self, market: str) -> str:
        """The gateway contract every call about this market must go through."""
        return self._deployment(market).gateway

    # ---------------------------------------------------------------- reading

    def market_addresses(self, deployment: str | None = None) -> list[str]:
        """Every market ever created, newest first, straight from the factories."""
        names = [deployment] if deployment else list(self._dep)
        # market lists only ever grow, so the ones already seen are kept on disk and only new ones are fetched
        path = _cache_dir() / f"markets-{self.network.name}-{self.network.chain_id}.json" if self.cache else None
        if path and not self._addresses and path.exists():
            try:
                self._addresses = {k: list(v) for k, v in json.loads(path.read_text()).items() if k in self._dep}
            except (ValueError, OSError):
                self._addresses = {}
        before = sum(len(v) for v in self._addresses.values())
        totals = self.reader.run([Call(self._fac[n], "getTotalMarketProxiesCount") for n in names])
        out: list[str] = []
        for name, total in zip(names, totals):
            if isinstance(total, Exception):
                continue
            have = self._addresses.setdefault(name, [])
            if len(have) < total:
                calls = [Call(self._fac[name], "getMarketProxies", [i, min(i + 499, total - 1)])
                         for i in range(len(have), total, 500)]
                for chunk in self.reader.run(calls):
                    if not isinstance(chunk, Exception):
                        have.extend(checksum(a) for a in chunk)
            for a in have:
                self._where[a.lower()] = name
            out.extend(have)
        if path and sum(len(v) for v in self._addresses.values()) > before:
            try:
                path.write_text(json.dumps(self._addresses))
            except OSError:
                pass
        return list(reversed(out))

    def markets(self, status: str | Iterable[str] | None = "open", *, deployment: str | None = None,
                limit: int | None = None, with_rules: bool = True) -> list[Market]:
        """Markets with live odds. ``status`` is one of open, awaiting_settlement, settled, expired, failed,
        a list of them, or None for all. Open markets are sorted by closing time, soonest first."""
        wanted = {status} if isinstance(status, str) else (set(status) if status else None)
        if wanted and not wanted <= set(STATUSES):
            raise ValueError(f"status must be among {STATUSES}")
        addrs = self.market_addresses(deployment)
        statuses = self._statuses(addrs)
        chosen = [a for a, s in zip(addrs, statuses)
                  if not isinstance(s, Exception) and (wanted is None or STATUSES[s] in wanted)]
        if limit and not (wanted == {"open"}):
            chosen = chosen[:limit]
        found = self._load(chosen, with_rules=with_rules)
        if wanted == {"open"}:
            found.sort(key=lambda m: m.trading_closes_at.timestamp() if m.trading_closes_at else math.inf)
        return found[:limit] if limit else found

    def _statuses(self, addrs: list[str]) -> list:
        """marketStatus for each address. Settled, expired and failed are final, so they are remembered on disk and
        only markets that can still change are asked about again."""
        path = _cache_dir() / f"status-{self.network.name}-{self.network.chain_id}.json" if self.cache else None
        final: dict[str, int] = {}
        if path and path.exists():
            try:
                final = {k: int(v) for k, v in json.loads(path.read_text()).items()}
            except (ValueError, OSError):
                final = {}
        ask = [a for a in addrs if a.lower() not in final]
        live = dict(zip((a.lower() for a in ask),
                        self.reader.run([Call(self._gw[self._where[a.lower()]], "marketStatus", [a]) for a in ask])))
        fresh = {a: s for a, s in live.items() if isinstance(s, int) and STATUSES[s] in FINAL_STATUSES}
        if path and fresh:
            final.update(fresh)
            try:
                path.write_text(json.dumps(final))
            except OSError:
                pass
        return [final.get(a.lower(), live.get(a.lower(), Exception("unknown"))) for a in addrs]

    def market(self, address: str, *, with_rules: bool = True) -> Market:
        if not Web3.is_address(address):
            raise DelphiError(f"{address!r} is not a market address")
        self._deployment(address)
        return self._load([checksum(address)], with_rules=with_rules)[0]

    def _load(self, addrs: list[str], with_rules: bool) -> list[Market]:
        if not addrs:
            return []
        calls: list[Call] = []
        for a in addrs:
            g = self._gw[self._deployment(a).name]
            calls += [Call(g, "getMarket", [a]), Call(g, "marketStatus", [a]), Call(g, "marketMetadata", [a])]
        base = self.reader.run(calls)
        rows = [base[i:i + 3] for i in range(0, len(base), 3)]
        for r in rows:  # marketMetadata decodes to {"uri", "uriContentHash"}; keep it as a pair
            if isinstance(r[2], dict):
                r[2] = (r[2]["uri"], r[2]["uriContentHash"])
        n_out = [int(r[0]["config"]["outcomeCount"]) if isinstance(r[0], dict) else 0 for r in rows]
        price_calls: list[Call] = []
        for a, n in zip(addrs, n_out):
            g = self._gw[self._deployment(a).name]
            price_calls += [Call(g, "spotImpliedProbabilities", [a, list(range(n))]), Call(g, "spotPrices", [a, list(range(n))])]
        prices = self.reader.run(price_calls)
        metas = self._metadata([r[2] if not isinstance(r[2], Exception) else None for r in rows]) if with_rules else [(None, None)] * len(rows)
        out: list[Market] = []
        for i, (a, r) in enumerate(zip(addrs, rows)):
            dep = self._deployment(a)
            info, st, md = r
            if isinstance(info, Exception):
                continue
            cfg = info["config"]
            probs = prices[2 * i]
            spot = prices[2 * i + 1]
            meta, verified = metas[i]
            win = info.get("winningOutcomeIdx")
            n = int(cfg["outcomeCount"])
            outcomes = list(meta.get("outcomes") or []) if meta else []
            model = (meta or {}).get("model") or {}
            out.append(Market(
                address=checksum(a),
                deployment=dep.name,
                mechanism="lmsr" if dep.kind.startswith("lmsr") else "dpm",
                status=STATUSES[st] if isinstance(st, int) else "unknown",
                question=(meta or {}).get("question"),
                outcomes=outcomes if len(outcomes) == n else (outcomes or [f"Outcome {j}" for j in range(n)]),
                probabilities=[p / 1e18 for p in probs] if not isinstance(probs, Exception) else [],
                prices=[p / 10**self.network.token_decimals for p in spot] if not isinstance(spot, Exception) else [],
                trading_closes_at=ts(cfg.get("tradingDeadline")),
                settlement_deadline=ts(cfg.get("settlementDeadline")),
                earliest_resolve_at=ts(cfg.get("earliestResolveTime")),
                winning_outcome=None if win is None or win >= n else int(win),
                pool_usd=info["pool"] / 10**self.network.token_decimals,
                trading_fee=cfg["tradingFee"] / 1e18,
                rules=model.get("prompt_context") or (meta or {}).get("resolutionPrompt"),
                sources=list((meta or {}).get("data_sources") or (meta or {}).get("dataSources") or []),
                judge_model=model.get("model_identifier"),
                metadata_uri=md[0] if isinstance(md, tuple) else None,
                metadata_verified=verified,
                url=f"{self.network.explorer_url}/address/{checksum(a)}",
                gateway=dep.gateway,
                raw_metadata=meta,
            ))
        return out

    def _metadata(self, entries: list[Optional[tuple]]) -> list[tuple[Optional[dict], Optional[bool]]]:
        """Fetch each market's rules file, check it against the on-chain hash, cache it on disk."""
        cache = _cache_dir() / "metadata" if self.cache else None
        if cache:
            cache.mkdir(exist_ok=True)

        def get(entry: Optional[tuple]) -> tuple[Optional[dict], Optional[bool]]:
            if not entry or not entry[0]:
                return None, None
            uri, h = entry[0], bytes(entry[1]).hex()
            if uri in self._meta:
                return self._meta[uri]
            f = cache / f"{h}.json" if cache else None
            body: Optional[bytes] = f.read_bytes() if f and f.exists() else None
            if body is None and uri.startswith("http"):
                for attempt in range(3):
                    try:
                        r = self._http.get(uri)
                        if r.status_code == 200:
                            body = r.content
                        break
                    except httpx.HTTPError:
                        time.sleep(0.5 * (attempt + 1))
            if body is None:
                return None, None
            verified = hashlib.sha256(body).hexdigest() == h or Web3.keccak(body).hex().removeprefix("0x") == h
            try:
                data = json.loads(body)
            except ValueError:
                return None, False
            if f and verified and not f.exists():
                f.write_bytes(body)
            self._meta[uri] = (data, verified)
            return data, verified

        with ThreadPoolExecutor(max_workers=16) as pool:
            return list(pool.map(get, entries))

    def search(self, query: str, *, status: str | None = "open", limit: int = 10) -> list[Market]:
        """Find markets by words in the question, outcomes or rules. Delphi's own app has no search."""
        from .search import rank
        return rank(self.markets(status=status), query)[:limit]

    # ---------------------------------------------------------------- quotes

    def _resolve(self, market: str | Market, outcome: int | str) -> tuple[Market, int]:
        m = market if isinstance(market, Market) else self.market(market)
        return m, m.outcome_index(outcome)

    def _quote_raw(self, m: Market, idx: int, shares_raw: int, side: str) -> int:
        g = self._gw[m.deployment]
        fn = "quoteBuyExactOut" if side == "buy" else "quoteSellExactIn"
        r = getattr(g.functions, fn)(checksum(m.address), idx, shares_raw).call()
        return int(r[0] if isinstance(r, (list, tuple)) else r)

    def quote_buy(self, market: str | Market, outcome: int | str, *, shares: float | None = None,
                  usd: float | None = None) -> Quote:
        """What a buy costs. Give ``shares`` for an exact share count, or ``usd`` for the most shares a budget
        buys (fees included, never over budget)."""
        if (shares is None) == (usd is None):
            raise ValueError("give exactly one of shares= or usd=")
        m, idx = self._resolve(market, outcome)
        if m.status != "open":
            raise DelphiError(f"market is {m.status}, not open for trading")
        unit = 10**self.network.token_decimals
        if shares is not None:
            raw = int(round(shares * SHARE))
            if raw <= 0:
                raise ValueError("shares must be more than zero")
            try:
                cost = self._quote_raw(m, idx, raw, "buy")
            except Exception:  # noqa: BLE001
                raise DelphiError(f"this market can't sell {shares:g} shares of that outcome: it is more than its pool "
                                  "can price. Try fewer, or quote with usd= to see the most a budget buys") from None
        else:
            if usd <= 0:
                raise ValueError("usd must be more than zero")
            raw, cost = self._fit_budget(m, idx, int(usd * unit))
        q = self._quote(m, idx, "buy", raw, cost)
        if usd is not None and cost < usd * unit * 0.95:
            q.note = f"this is the most the pool can sell right now; ${usd:,.2f} would not all be spent"
        return q

    def _fit_budget(self, m: Market, idx: int, budget: int) -> tuple[int, int]:
        """Largest share count whose cost is within budget. Cost rises with shares, so bracket the answer and close in.
        If the pool can't price a size at all, the answer is the largest size it can, which may cost less than budget."""
        def cost_of(shares: float) -> int | None:
            try:
                return self._quote_raw(m, idx, int(shares * SHARE), "buy")
            except Exception:  # noqa: BLE001  (more shares than the pool can price)
                return None

        p = m.prices[idx] if m.prices and m.prices[idx] > 0 else 0.5
        guess = budget / (10**self.network.token_decimals) / p
        lo: tuple[float, int] | None = None            # largest size known to fit: (shares, cost)
        hi: tuple[float, int | None] | None = None     # smallest size known not to fit; cost None = can't be priced
        for _ in range(60):
            c = cost_of(guess)
            if c is not None and c <= budget:
                lo = (guess, c)
                if c >= budget * 0.998:
                    break
                if hi is None:
                    guess *= max(1.05, min(4.0, budget / max(c, 1)))
                    continue
            else:
                hi = (guess, c)
                if lo is None:
                    guess *= max(0.25, min(0.9, budget / c)) if c else 0.5
                    if guess * SHARE < 1:
                        break
                    continue
            if (hi[0] - lo[0]) / hi[0] < 0.0005:
                break
            if hi[1] is not None and hi[1] > lo[1]:   # both priced: aim where the line between them meets the budget
                guess = lo[0] + (hi[0] - lo[0]) * (budget - lo[1]) / (hi[1] - lo[1])
                guess = min(max(guess, lo[0] + (hi[0] - lo[0]) * 0.02), hi[0] - (hi[0] - lo[0]) * 0.02)
            else:
                guess = (lo[0] + hi[0]) / 2
        if not lo:
            raise DelphiError("the budget is too small to buy any shares")
        return int(lo[0] * SHARE), lo[1]

    def quote_sell(self, market: str | Market, outcome: int | str, shares: float) -> Quote:
        m, idx = self._resolve(market, outcome)
        if m.status != "open":
            raise DelphiError(f"market is {m.status}, not open for trading")
        raw = int(round(shares * SHARE))
        return self._quote(m, idx, "sell", raw, self._quote_raw(m, idx, raw, "sell"))

    def _quote(self, m: Market, idx: int, side: str, shares_raw: int, usd_raw: int) -> Quote:
        unit = 10**self.network.token_decimals
        after = None
        if m.mechanism == "lmsr":
            fn = "quoteBuyExactOut" if side == "buy" else "quoteSellExactIn"
            try:
                _, new_exp, new_sum = getattr(self._gw[m.deployment].functions, fn)(checksum(m.address), idx, shares_raw).call()
                after = new_exp / new_sum if new_sum else None
            except Exception:  # noqa: BLE001
                after = None
        shares = shares_raw / SHARE
        return Quote(market=m.address, outcome=idx, outcome_label=m.outcomes[idx] if idx < len(m.outcomes) else None,
                     side=side, shares=shares, usd=usd_raw / unit,
                     average_price=(usd_raw / unit / shares) if shares else None,
                     probability_before=m.probabilities[idx] if m.probabilities else None,
                     probability_after=after, shares_raw=shares_raw, usd_raw=usd_raw)

    # ---------------------------------------------------------------- trading

    def _need_account(self):
        if not self.account:
            raise DelphiError("no wallet key: set AGON_PRIVATE_KEY (or pass private_key= in code)")
        return self.account

    def _send(self, fn) -> dict:
        acct = self._need_account()
        tx = fn.build_transaction({
            "from": acct.address,
            "nonce": self.w3.eth.get_transaction_count(acct.address, "pending"),
            "chainId": self.network.chain_id,
        })
        signed = acct.sign_transaction(tx)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = self.w3.eth.wait_for_transaction_receipt(h, timeout=180)
        if receipt["status"] != 1:
            raise DelphiError(f"transaction reverted: {self.tx_url(h.hex())}")
        return receipt

    def tx_url(self, tx_hash: str) -> str:
        h = tx_hash if tx_hash.startswith("0x") else "0x" + tx_hash
        return f"{self.network.explorer_url}/tx/{h}"

    def _ensure_allowance(self, spender: str, amount: int, unlimited: bool) -> Optional[str]:
        acct = self._need_account()
        have = self.token.functions.allowance(acct.address, checksum(spender)).call()
        if have >= amount:
            return None
        r = self._send(self.token.functions.approve(checksum(spender), MAX_UINT if unlimited else amount))
        return "0x" + r["transactionHash"].hex().removeprefix("0x")

    def buy(self, market: str | Market, outcome: int | str, *, usd: float | None = None, shares: float | None = None,
            max_slippage: float = 0.02, approve_unlimited: bool = False, belief=None, reasoning: str | None = None,
            receipt: str | None = None) -> Trade:
        """Buy shares of one outcome. ``usd`` spends up to that budget; ``shares`` buys an exact count.
        Approves only the amount needed unless ``approve_unlimited``.

        With recording on, ``belief`` is required: the probabilities the agent believes, e.g.
        ``{"Yes": 0.71}`` (one side is enough for yes/no markets). ``reasoning`` is sealed with it."""
        acct = self._need_account()
        m, idx = self._resolve(market, outcome)
        q = self.quote_buy(m, idx, usd=usd, shares=shares)
        if self.recorder and belief is None:
            raise DelphiError('recording is on: say what you believe, e.g. belief={"Yes": 0.7}')
        if self.recorder:
            from .recorder import RecorderError, belief_vector
            belief_vector(m, belief)  # bad beliefs fail here, before any approval is sent
            if self.record_mode != "try":
                try:
                    self.recorder.check(m)  # and so do markets Agon doesn't record
                except RecorderError as err:
                    raise DelphiError(f"not traded: the belief could not be recorded ({err})") from None
        max_in = math.ceil(q.usd_raw * (1 + max_slippage))
        if usd is not None:  # a dollar budget is a ceiling: if the price moves past it the buy reverts, it never overspends
            max_in = min(max_in, int(usd * 10**self.network.token_decimals))
        have = self.token.functions.balanceOf(acct.address).call()
        if have < max_in:
            raise InsufficientFunds(f"need up to ${max_in / 10**self.network.token_decimals:.2f}, wallet has ${have / 10**self.network.token_decimals:.2f}")
        # trades go through the gateway, but the market contract itself pulls the USDC, so it is the spender
        approval = self._ensure_allowance(m.address, max_in, approve_unlimited)
        fn = self._gw[m.deployment].functions.buyExactOut(checksum(m.address), idx, q.shares_raw, max_in)
        sim = fn.call({"from": acct.address})
        # log the belief last, once the trade is known to go through, so a buy that would fail leaves no entry
        rec = self._log_belief(m, idx, belief, reasoning, receipt) if self.recorder else None
        r = self._send(fn)
        paid = int(sim[0] if isinstance(sim, (list, tuple)) else sim)
        h = "0x" + r["transactionHash"].hex().removeprefix("0x")
        return Trade(market=m.address, outcome=idx, outcome_label=q.outcome_label, side="buy", shares=q.shares,
                     usd=paid / 10**self.network.token_decimals, tx_hash=h, explorer_url=self.tx_url(h), approval_tx=approval,
                     record=rec)

    def _log_belief(self, m: Market, idx: int, belief, reasoning, receipt) -> dict:
        """Seal the agent's belief before a trade. Raises (so nothing is traded) unless record="try"."""
        from .recorder import RecorderError, belief_vector
        vec = belief_vector(m, belief)
        mine, theirs = vec[idx] / (sum(vec) or 1), (m.probabilities[idx] if idx < len(m.probabilities) else None)
        try:
            e = self.recorder.log(m, vec, reasoning, receipt=receipt)
        except (RecorderError, ValueError) as err:
            if self.record_mode == "try":
                return {"logged": False, "error": str(err)}
            raise DelphiError(f"not traded: the belief could not be recorded ({err})") from None
        return {"logged": True, "entry": e.id, "belief": round(mine, 4), "market_probability": theirs,
                "edge": round(mine - theirs, 4) if theirs is not None else None, "sealed_until": e.sealed_until,
                "record_url": e.url, "proof_url": e.proof_url}

    def sell(self, market: str | Market, outcome: int | str, shares: float | None = None, *,
             max_slippage: float = 0.02) -> Trade:
        """Sell shares back to the market. ``shares=None`` sells everything held in that outcome."""
        acct = self._need_account()
        m, idx = self._resolve(market, outcome)
        g = self._gw[m.deployment]
        raw = int(round(shares * SHARE)) if shares is not None else g.functions.balanceOf(checksum(m.address), acct.address, idx).call()
        if raw <= 0:
            raise DelphiError("no shares to sell")
        out = self._quote_raw(m, idx, raw, "sell")
        min_out = math.floor(out * (1 - max_slippage))
        fn = g.functions.sellExactIn(checksum(m.address), idx, raw, min_out)
        sim = fn.call({"from": acct.address})
        r = self._send(fn)
        got = int(sim[0] if isinstance(sim, (list, tuple)) else sim)
        h = "0x" + r["transactionHash"].hex().removeprefix("0x")
        return Trade(market=m.address, outcome=idx, outcome_label=m.outcomes[idx] if idx < len(m.outcomes) else None,
                     side="sell", shares=raw / SHARE, usd=got / 10**self.network.token_decimals, tx_hash=h, explorer_url=self.tx_url(h))

    def redeem(self, market: str) -> dict:
        """Collect winnings from a settled market."""
        acct = self._need_account()
        g = self._gw[self._deployment(market).name]
        fn = g.functions.redeem(checksum(market))
        shares_in, tokens_out = fn.call({"from": acct.address})
        r = self._send(fn)
        h = "0x" + r["transactionHash"].hex().removeprefix("0x")
        return {"market": checksum(market), "shares": shares_in / SHARE, "usd": tokens_out / 10**self.network.token_decimals,
                "tx_hash": h, "explorer_url": self.tx_url(h)}

    def liquidate(self, market: str, outcomes: list[int] | None = None) -> dict:
        """Recover funds from an expired or failed market (paid at final prices, not refunded at cost)."""
        acct = self._need_account()
        m = self.market(market, with_rules=False)
        g = self._gw[m.deployment]
        idxs = outcomes if outcomes is not None else [
            i for i in range(len(m.probabilities)) if g.functions.balanceOf(checksum(market), acct.address, i).call() > 0]
        fn = g.functions.liquidate(checksum(market), idxs)
        shares_in, tokens_out = fn.call({"from": acct.address})
        r = self._send(fn)
        h = "0x" + r["transactionHash"].hex().removeprefix("0x")
        return {"market": checksum(market), "shares": [s / SHARE for s in shares_in],
                "usd": tokens_out / 10**self.network.token_decimals, "tx_hash": h, "explorer_url": self.tx_url(h)}

    # ---------------------------------------------------------------- positions

    def positions(self, wallet: str | None = None, *, markets: list[str | Market] | None = None,
                  include_empty_closed: bool = False) -> list[Position]:
        """Every share a wallet holds, in every market of every deployment (or just ``markets``), with what to
        do next. No API key: balances are read from the chain in a few batched calls."""
        w = checksum(wallet or self._need_account().address)
        if markets is not None:
            addrs = [checksum(m.address if isinstance(m, Market) else m) for m in markets]
            for a in addrs:
                self._deployment(a)
        else:
            addrs = self.market_addresses()
        info = self.reader.run([Call(self._gw[self._where[a.lower()]], "getMarket", [a]) for a in addrs])
        counts = [int(i["config"]["outcomeCount"]) if isinstance(i, dict) else 0 for i in info]
        bal = self.reader.run([Call(self._gw[self._where[a.lower()]], "batchBalanceOf", [a, [w] * n, list(range(n))])
                               for a, n in zip(addrs, counts)])
        held = [(a, b) for a, b in zip(addrs, bal) if not isinstance(b, Exception) and any(b)]
        if not held:
            return []
        markets = {m.address.lower(): m for m in self._load([a for a, _ in held], with_rules=True)}
        out: list[Position] = []
        for a, b in held:
            m = markets.get(a.lower())
            if not m:
                continue
            for idx, raw in enumerate(b):
                if raw <= 0:
                    continue
                sh = raw / SHARE
                p = m.probabilities[idx] if idx < len(m.probabilities) else None
                action, claim, value = None, None, (sh * p if p is not None else None)
                if m.status == "settled":
                    won = m.winning_outcome == idx
                    value = None
                    if won:
                        action = "redeem"
                        try:
                            claim = self._gw[m.deployment].functions.redeem(checksum(a)).call({"from": w})[1] / 10**self.network.token_decimals
                        except Exception:  # noqa: BLE001  (already redeemed, or nothing to claim)
                            claim = None
                        value = claim
                    elif not include_empty_closed:
                        continue
                elif m.status in ("expired", "failed"):
                    action = "liquidate"
                out.append(Position(market=m.address, question=m.question, outcome=idx,
                                    outcome_label=m.outcomes[idx] if idx < len(m.outcomes) else None,
                                    shares=sh, probability=p, value_usd=value, status=m.status,
                                    action=action, claimable_usd=claim))
        return out
