"""Full trading lifecycle against a local fork of Gensyn mainnet (no real money).

Needs Foundry's `anvil`. Starts a fork, funds a throwaway wallet with USDC taken from a market's pool, then:
buy → positions → sell → time-travel past the deadline → settle as Delphi's oracle relayer → redeem (LMSR),
and buy → let the market expire unsettled → liquidate (DPM).

    uv run pytest tests/test_fork.py -s
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
from pathlib import Path

import httpx
import pytest
from web3 import Web3

from agon import Delphi
from agon.chain import ERC20_ABI

ANVIL = shutil.which("anvil") or str(Path.home() / ".foundry" / "bin" / "anvil")
pytestmark = pytest.mark.skipif(not Path(ANVIL).exists(), reason="anvil not installed")

# anvil's first default account (public test key, never holds real funds)
KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
TRANSFER_ABI = ERC20_ABI + [{"type": "function", "name": "transfer", "stateMutability": "nonpayable",
                             "inputs": [{"name": "to", "type": "address"}, {"name": "amount", "type": "uint256"}],
                             "outputs": [{"name": "", "type": "bool"}]}]


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture  # a fresh fork per test: tests move the clock
def fork():
    if os.environ.get("AGON_TEST_RPC"):  # reuse a fork that is already running (the local Agon server reads it too)
        url = os.environ["AGON_TEST_RPC"]
        yield url, Web3(Web3.HTTPProvider(url))
        return
    port = _free_port()
    proc = subprocess.Popen([ANVIL, "--fork-url", os.environ.get("AGON_FORK_RPC", "https://gensyn-mainnet.g.alchemy.com/public"),
                             "--port", str(port), "--chain-id", "685689", "--silent",
                             # the public RPC rate-limits; back off instead of failing
                             "--retries", "12", "--fork-retry-backoff", "1500"])
    url = f"http://127.0.0.1:{port}"
    w3 = Web3(Web3.HTTPProvider(url))
    for _ in range(120):
        try:
            if w3.is_connected():
                break
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.5)
    yield url, w3
    proc.terminate()


def _fund(w3: Web3, d: Delphi, donor: str, usd: float) -> None:
    w3.provider.make_request("anvil_setBalance", [ADDR, hex(10**18)])
    w3.provider.make_request("anvil_setBalance", [donor, hex(10**18)])
    w3.provider.make_request("anvil_impersonateAccount", [donor])
    token = w3.eth.contract(address=d.token.address, abi=TRANSFER_ABI)
    tx = token.functions.transfer(ADDR, int(usd * 1e6)).transact({"from": donor})
    w3.eth.wait_for_transaction_receipt(tx)
    w3.provider.make_request("anvil_stopImpersonatingAccount", [donor])


def test_lifecycle(fork):
    url, w3 = fork
    # pick the market on real mainnet (fast); the fork fetches state lazily, so keep fork reads to one market
    live = Delphi(cache=True)
    open_lmsr = [m for m in live.markets(status="open") if m.mechanism == "lmsr" and (m.pool_usd or 0) > 15]
    assert open_lmsr, "no open LMSR market with a pool to test against"
    pick = open_lmsr[-1]  # the one closing last, so it stays open while we trade
    d = Delphi(rpc_url=url, private_key=KEY, cache=True)
    m = d.market(pick.address)
    assert m.status == "open"
    _fund(w3, d, m.address, 10)
    assert d.balance()["usd"] >= 10

    # buy with a budget, never over it
    q = d.quote_buy(m, "Yes", usd=3)
    assert q.usd <= 3
    t = d.buy(m, "Yes", usd=3)
    print("\nbuy", t)
    assert t.usd <= 3 * 1.02 and t.shares > 0 and t.approval_tx

    pos = {(p.market, p.outcome): p for p in d.positions(markets=[m])}
    held = pos[(m.address, 0)]
    assert abs(held.shares - t.shares) < 1e-9

    # sell half back
    s = d.sell(m, "Yes", held.shares / 2)
    print("sell", s)
    assert s.usd > 0

    # jump past the deadline, ask for resolution, settle as the oracle relayer, then redeem
    m = d.market(m.address)
    target = int((m.earliest_resolve_at or m.trading_closes_at).timestamp()) + 60
    w3.provider.make_request("evm_setNextBlockTimestamp", [target])
    w3.provider.make_request("evm_mine", [])
    assert d.market(m.address, with_rules=False).status == "awaiting_settlement"
    gw = d._gw[m.deployment]
    tx = gw.functions.resolveMarket(m.address).transact({"from": ADDR})
    w3.eth.wait_for_transaction_receipt(tx)
    relayer = gw.functions.oracleRelayer().call()
    w3.provider.make_request("anvil_setBalance", [relayer, hex(10**18)])
    w3.provider.make_request("anvil_impersonateAccount", [relayer])
    tx = gw.functions.settleMarket(m.address, 0, relayer).transact({"from": relayer})
    w3.eth.wait_for_transaction_receipt(tx)
    assert d.market(m.address, with_rules=False).status == "settled"

    claim = [p for p in d.positions(markets=[m]) if p.market == m.address]
    print("claimable", claim)
    assert claim and claim[0].action == "redeem" and claim[0].claimable_usd and claim[0].claimable_usd > 0
    before = d.balance()["usd"]
    r = d.redeem(m.address)
    print("redeem", r)
    assert abs(d.balance()["usd"] - before - r["usd"]) < 1e-6
    assert r["usd"] == pytest.approx(claim[0].claimable_usd)


def test_dpm_expire_and_liquidate(fork):
    url, w3 = fork
    live = Delphi(cache=True)
    opens = [m for m in live.markets(status="open") if m.mechanism == "dpm" and (m.pool_usd or 0) > 5]
    assert opens, "no open DPM market to test against"
    d = Delphi(rpc_url=url, private_key=KEY, cache=True)
    m = d.market(opens[0].address)
    _fund(w3, d, m.address, 3)

    t = d.buy(m, 0, usd=1)
    print("\nbuy", m.deployment, t)
    assert 0 < t.usd <= 1 and t.shares > 0

    # nobody settles it: after the settlement deadline it expires and holders liquidate at final prices
    w3.provider.make_request("evm_setNextBlockTimestamp", [int(m.settlement_deadline.timestamp()) + 60])
    w3.provider.make_request("evm_mine", [])
    assert d.market(m.address, with_rules=False).status == "expired"
    pos = d.positions(markets=[m])
    assert pos and pos[0].action == "liquidate"
    before = d.balance()["usd"]
    r = d.liquidate(m.address)
    print("liquidate", r)
    assert r["usd"] > 0 and abs(d.balance()["usd"] - before - r["usd"]) < 1e-6
    assert d.positions(markets=[m]) == []


RECORDER = os.environ.get("AGON_TEST_URL")  # a local Agon server, e.g. http://localhost:8841


@pytest.mark.skipif(not RECORDER, reason="set AGON_TEST_URL to a local Agon server")
def test_recording(fork):
    """record=True: no belief, no trade; with a belief, it is sealed on Agon before the buy is sent."""
    from agon import DelphiError
    url, w3 = fork
    fixtures = httpx.get(f"{RECORDER}/league/v1/fixtures").json()["fixtures"]
    live = Delphi(cache=True)
    lmsr = {m.address.lower(): m for m in live.markets(status="open") if m.mechanism == "lmsr" and (m.pool_usd or 0) > 15}
    target = next(f["market"] for f in reversed(fixtures) if f["market"] in lmsr)
    d = Delphi(rpc_url=url, private_key=KEY, record=True, recorder_url=RECORDER, agent_name="agon python fork test")
    m = d.market(target)
    _fund(w3, d, m.address, 5)
    before = d.balance()["usd"]

    with pytest.raises(DelphiError, match="say what you believe"):
        d.buy(m, "Yes", usd=1)
    assert d.balance()["usd"] == before  # nothing traded

    t = d.buy(m, "Yes", usd=1, belief={"Yes": 0.62}, reasoning="Fork test: stated belief before buying.")
    print("\nrecorded buy", t.record)
    assert t.record["logged"] and t.record["belief"] == pytest.approx(0.62)
    assert t.record["edge"] == pytest.approx(0.62 - m.probabilities[0], abs=1e-4)

    rec = d.recorder.record()
    mine = [f for f in rec["forecasts"] if f["id"] == t.record["entry"]]
    assert mine, "entry missing from the agent's record"
    print("entry as the public sees it while sealed:", mine[0])
    assert rec["address"].lower() == d.address.lower()  # the name sticks from the wallet's first registration
    proof = httpx.get(t.record["proof_url"]).json()
    print("proof", proof)
    # timelocked by default, and committed on chain by the trading wallet before the buy
    assert t.record["timelocked"] and t.record["commit_tx"]
    commit = w3.eth.get_transaction_receipt(t.record["commit_tx"])
    buy = w3.eth.get_transaction_receipt(t.tx_hash)
    assert (commit["blockNumber"], commit["transactionIndex"]) < (buy["blockNumber"], buy["transactionIndex"])
    assert mine[0]["sealed"] and mine[0]["timelock"]["state"] == "locked" and "probabilities" not in mine[0]
    assert mine[0]["commit"]["tx"] == t.record["commit_tx"]
