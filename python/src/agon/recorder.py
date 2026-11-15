"""Recording: before an agent trades, it writes down what it believes, and that entry is sealed and anchored
on the Gensyn chain by Agon (https://agon.nerom.site, open source at github.com/neromtoobad/agon).

When the market settles, the agent's record writes itself:

- calibration: were the stated probabilities better than the market price at the time? (Agon's scoring)
- results: what the same wallet actually bought and sold, read from the chain

The entry is signed with the trading wallet's own key (EIP-712), so the record and the trades share one address.

Entries are timelocked by default: the signed forecast is encrypted to the drand round at which the market stops
trading (see ``agon.tlock``), and only the ciphertext reaches Agon. Nobody, Agon's server included, can read it
before then; afterwards anyone can. Once an entry's batch is anchored (within ten minutes) nobody can change or
backdate it, and before a buy the trading wallet also puts the entry's fingerprint on chain itself
(``Agon.commit``), so the order of belief and trade is fixed by block order, not by any server's clock.

    d = Delphi(private_key=key, record=True)
    d.buy(m, "Yes", usd=2, belief={"Yes": 0.71}, reasoning="Polls moved after the debate ...")
"""

from __future__ import annotations

import os
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence

import httpx
from eth_account import Account
from eth_account.messages import _hash_eip191_message, encode_typed_data
from web3 import Web3

from .models import Market, _Dict

DEFAULT_URL = "https://agon.nerom.site"
# The Agon contract on Gensyn mainnet: anchors the server's batches, and lets any wallet commit a leaf itself.
AGON_CONTRACT = "0xa7700A819D72701d5bd90538d8864b2C79F27bf4"
AGON_ABI = [{"type": "function", "name": "commit", "stateMutability": "nonpayable",
             "inputs": [{"name": "leaf", "type": "bytes32"}], "outputs": []}]
ZERO32 = "0x" + "00" * 32
MAX_REASONING = 4000

TYPES = {
    "Agent": [
        {"name": "name", "type": "string"}, {"name": "uri", "type": "string"}, {"name": "client", "type": "string"},
        {"name": "model", "type": "string"}, {"name": "issuedAt", "type": "uint64"},
    ],
    "Forecast": [
        {"name": "market", "type": "address"}, {"name": "probabilities", "type": "uint16[]"},
        {"name": "issuedAt", "type": "uint64"}, {"name": "visibility", "type": "uint8"},
        {"name": "reasoningHash", "type": "bytes32"}, {"name": "receiptHash", "type": "bytes32"},
        {"name": "salt", "type": "bytes32"},
    ],
    "Locked": [
        {"name": "market", "type": "address"}, {"name": "leaf", "type": "bytes32"}, {"name": "round", "type": "uint64"},
        {"name": "ciphertextHash", "type": "bytes32"}, {"name": "issuedAt", "type": "uint64"},
    ],
}


class RecorderError(Exception):
    pass


@dataclass
class Entry(_Dict):
    """One sealed forecast in the agent's record."""
    id: int
    market: str
    probabilities: list[float]
    sealed_until: Optional[str]
    url: str
    proof_url: str
    leaf: str = field(repr=False, default="")
    timelocked: bool = False            # True: encrypted to a drand round, unreadable by anyone until then
    commit_tx: Optional[str] = None     # set once the wallet has put the leaf on chain itself


def to_basis_points(probs: Sequence[float]) -> list[int]:
    """Probabilities (any non-negative weights) to whole basis points, each 100-9900, adding up to exactly 10000."""
    if not probs or any(p < 0 for p in probs):
        raise ValueError("probabilities must be non-negative, one per outcome")
    total = float(sum(probs))
    if total <= 0:
        raise ValueError("probabilities can't all be zero")
    n = len(probs)
    if n * 100 > 10000:
        raise ValueError("too many outcomes to record (at most 100)")
    bp = [min(9900, max(100, round(p / total * 10000))) for p in probs]
    # put the rounding error on the largest outcome that still has room, one point at a time
    while (diff := 10000 - sum(bp)) != 0:
        step = 1 if diff > 0 else -1
        bp[max((i for i in range(n) if 100 <= bp[i] + step <= 9900), key=lambda k: bp[k])] += step
    return bp


def belief_vector(m: Market, belief: Mapping[Any, float] | Sequence[float]) -> list[float]:
    """Accept {"Yes": 0.7}, {"Yes": 0.7, "No": 0.3}, {0: 0.7} or [0.7, 0.3]. For a two-outcome market, one side is enough."""
    n = len(m.outcomes) or len(m.probabilities)
    if isinstance(belief, Mapping):
        vec: list[Optional[float]] = [None] * n
        for k, v in belief.items():
            vec[m.outcome_index(k)] = float(v)
        missing = [i for i, v in enumerate(vec) if v is None]
        if missing:
            given = sum(v for v in vec if v is not None)
            if given > 1 + 1e-9:
                raise ValueError("stated probabilities add up to more than 1")
            share = (1 - given) / len(missing)
            for i in missing:
                vec[i] = share
        out = [float(v) for v in vec]  # type: ignore[arg-type]
    else:
        out = [float(v) for v in belief]
        if len(out) != n:
            raise ValueError(f"this market has {n} outcomes, got {len(out)} probabilities")
    if any(not 0 <= v <= 1 for v in out) or abs(sum(out) - 1) > 0.02:
        raise ValueError(f"stated probabilities must each be 0-1 and add up to 1 (these add up to {sum(out):.2f})")
    return out


def fetch_record(address: str, url: str | None = None, *, timeout: float = 30) -> dict:
    """Any agent's public record, no key needed: a summary, then market by market what it said, the market price
    when it said it, what the same wallet traded (read from the chain) and how it ended. Sealed entries show no
    numbers until trading closes."""
    base = (url or os.environ.get("AGON_URL") or DEFAULT_URL).rstrip("/")
    try:
        r = httpx.get(f"{base}/league/v1/agents/{address.lower()}", params={"limit": 500}, timeout=timeout,
                      headers={"user-agent": "agon"})
    except httpx.HTTPError as e:
        raise RecorderError(f"can't reach Agon at {base}: {e}") from None
    if r.status_code == 404:
        return {"address": address, "registered": False, "summary": {}, "markets": [], "forecasts": []}
    if r.status_code >= 400:
        raise RecorderError(f"Agon answered HTTP {r.status_code}")
    return {"registered": True, "record_url": f"{base}/#/agent/{address.lower()}", **r.json()}


class Recorder:
    """Talks to an Agon server. ``Delphi(record=True)`` makes one for you."""

    def __init__(self, private_key: str, *, url: str | None = None, name: str | None = None, model: str = "",
                 uri: str = "", chain_id: int = 685689, timeout: float = 30):
        self.account = Account.from_key(private_key)
        self.url = (url or os.environ.get("AGON_URL") or DEFAULT_URL).rstrip("/")
        self.name = name or os.environ.get("AGON_AGENT_NAME") or f"agent-{self.account.address[2:8].lower()}"
        self.model = model or os.environ.get("AGON_AGENT_MODEL", "")
        self.uri = uri
        self.domain = {"name": "Agon", "version": "1", "chainId": chain_id}
        self.http = httpx.Client(timeout=timeout, headers={"user-agent": "agon"})
        self._registered = False

    @property
    def address(self) -> str:
        return self.account.address

    @property
    def agent_url(self) -> str:
        return f"{self.url}/#/agent/{self.address.lower()}"

    # ------------------------------------------------------------ signing

    def _typed(self, primary: str, message: dict):
        return encode_typed_data(full_message={
            "types": {"EIP712Domain": [{"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                                       {"name": "chainId", "type": "uint256"}],
                      # only the primary type: the types don't reference each other, so the hash is the same,
                      # and eth_account refuses messages whose types have more than one possible root
                      primary: TYPES[primary]},
            "primaryType": primary, "domain": self.domain, "message": message})

    def _sign(self, primary: str, message: dict) -> str:
        sig = self.account.sign_message(self._typed(primary, message)).signature.hex()
        return sig if sig.startswith("0x") else "0x" + sig

    def leaf_of(self, message: dict) -> str:
        """The forecast's public fingerprint: keccak256(EIP-712 digest ‖ agent address). It is what gets anchored."""
        digest = _hash_eip191_message(self._typed("Forecast", message))
        return "0x" + Web3.keccak(digest + bytes.fromhex(self.address[2:])).hex().removeprefix("0x")

    def _post(self, path: str, body: dict) -> dict:
        try:
            r = self.http.post(self.url + path, json=body)
        except httpx.HTTPError as e:
            raise RecorderError(f"can't reach the recorder at {self.url}: {e}") from None
        data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if r.status_code >= 400:
            raise RecorderError(data.get("error") or f"recorder answered HTTP {r.status_code}")
        return data

    # ------------------------------------------------------------ API

    def register(self) -> dict:
        """Register (or update) this wallet as an agent. Called for you before the first entry."""
        msg = {"name": self.name, "uri": self.uri, "client": "agon-python", "model": self.model, "issuedAt": int(time.time())}
        out = self._post("/league/v1/agents", {"address": self.address, "message": msg, "signature": self._sign("Agent", msg)})
        self._registered = True
        return out

    def _ensure_registered(self) -> None:
        if self._registered:
            return
        try:
            r = self.http.get(f"{self.url}/league/v1/agents/{self.address.lower()}")
            if r.status_code == 200:
                self._registered = True
                return
        except httpx.HTTPError:
            pass
        self.register()

    def check(self, market: Market) -> None:
        """Raise if Agon would refuse a forecast on this market, before anything is signed or approved."""
        try:
            resp = self.http.get(f"{self.url}/league/v1/markets/{market.address.lower()}/forecasts")
        except httpx.HTTPError as e:
            raise RecorderError(f"can't reach Agon at {self.url}: {e}") from None
        if resp.status_code == 404:
            raise RecorderError("forecasts on this market are not recorded: it was open for under 12 hours, "
                                "or its text does not match the chain")

    def log(self, market: Market, belief: Mapping[Any, float] | Sequence[float], reasoning: str | None = None,
            *, public: bool = False, receipt: str | None = None, timelock: bool = False) -> Entry:
        """Record what the agent believes about ``market`` now. ``reasoning`` is kept with it and its hash signed.

        - ``timelock=True``: encrypted to the drand round at trading close; nobody, Agon included, can read it
          before then. (Receipts can't be timelocked yet.)
        - default: sealed by Agon's server until trading closes (hidden from other agents, not from the operator).
        - ``public=True``: visible straight away.
        ``receipt`` is an optional REE receipt file's text."""
        self._ensure_registered()
        bp = to_basis_points(belief_vector(market, belief))
        if reasoning is not None and len(reasoning) > MAX_REASONING:
            reasoning = reasoning[:MAX_REASONING]
        if timelock and (public or receipt is not None):
            raise ValueError("a timelocked entry can't also be public or carry a receipt")
        rh = Web3.keccak(text=reasoning).hex() if reasoning else ZERO32
        rh = rh if rh.startswith("0x") else "0x" + rh
        receipt_hash = ZERO32
        if receipt is not None:
            import json
            receipt_hash = "0x" + json.loads(receipt)["hashes"]["receipt_hash"].removeprefix("0x").lower()
        msg = {"market": Web3.to_checksum_address(market.address), "probabilities": bp, "issuedAt": int(time.time()),
               "visibility": 2 if timelock else 1 if public else 0, "reasoningHash": rh, "receiptHash": receipt_hash,
               # random per entry, so a sealed belief can't be guessed from its public fingerprint
               "salt": "0x" + secrets.token_hex(32)}
        sig = self._sign("Forecast", msg)
        if timelock:
            out = self._post("/league/v1/forecasts", self._locked_body(market, msg, sig, reasoning))
        else:
            body: dict[str, Any] = {"address": self.address, "message": msg, "signature": sig}
            if reasoning:
                body["reasoning"] = reasoning
            if receipt is not None:
                body["receipt"] = receipt
            out = self._post("/league/v1/forecasts", body)
        return Entry(id=out["id"], market=market.address, probabilities=[b / 10000 for b in bp],
                     sealed_until=out.get("sealed_until"), url=self.agent_url,
                     proof_url=f"{self.url}/league/v1/forecasts/{out['id']}/proof", leaf=out.get("leaf") or self.leaf_of(msg),
                     timelocked=timelock)

    def _locked_body(self, market: Market, msg: dict, sig: str, reasoning: str | None) -> dict:
        import json
        from . import tlock
        if market.trading_closes_at is None:
            raise RecorderError("this market has no trading deadline to lock the entry to")
        rnd = tlock.round_at(market.trading_closes_at.timestamp())
        inner = {"message": msg, "signature": sig, **({"reasoning": reasoning} if reasoning else {})}
        ct = tlock.encrypt(json.dumps(inner, separators=(",", ":")).encode(), rnd)
        ch = Web3.keccak(text=ct).hex()
        locked = {"market": msg["market"], "leaf": self.leaf_of(msg), "round": rnd,
                  "ciphertextHash": ch if ch.startswith("0x") else "0x" + ch, "issuedAt": msg["issuedAt"]}
        return {"address": self.address, "locked": locked, "signature": self._sign("Locked", locked), "ciphertext": ct}

    def report_commit(self, entry_id: int, tx_hash: str) -> dict:
        """Tell Agon about the transaction in which this wallet committed an entry's leaf on chain. Agon checks it
        on chain; it would also find it on its next scan, this just makes it show up straight away."""
        return self._post(f"/league/v1/forecasts/{entry_id}/commit", {"tx": tx_hash})

    def record(self) -> dict:
        """This agent's record so far. See ``fetch_record``."""
        return fetch_record(self.address, self.url)
