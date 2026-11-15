"""Fast tests with no network: search, outcome labels, spending limits, and the budget fitter against a real
LMSR cost curve."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from agon.client import SHARE, Delphi, DelphiError
from agon.limits import Guard, LimitExceeded, Limits
from agon.models import Market
from agon.search import rank


def _m(addr: str, q: str, outcomes=("Yes", "No"), rules: str = "", hours: float = 24) -> Market:
    return Market(address=addr, deployment="lmsr", mechanism="lmsr", status="open", question=q,
                  outcomes=list(outcomes), probabilities=[0.5] * len(outcomes), prices=[0.5] * len(outcomes),
                  trading_closes_at=datetime.now(timezone.utc) + timedelta(hours=hours),
                  settlement_deadline=None, rules=rules)


# ------------------------------------------------------------------ search

def test_search_prefers_question_then_outcomes_then_rules():
    a = _m("0xa", "Will the Lakers win tonight?")
    b = _m("0xb", "Who wins the game?", outcomes=("Lakers", "Celtics"))
    c = _m("0xc", "Total points over 220?", rules="Use the final score of the Lakers game.")
    d = _m("0xd", "Will it rain in Lagos?")
    assert [m.address for m in rank([c, d, b, a], "lakers")] == ["0xa", "0xb", "0xc"]


def test_search_prefix_and_stop_words():
    a = _m("0xa", "Who wins the 2026 election in Brazil?")
    assert rank([a], "elect") == [a]
    assert rank([a], "el") == []          # prefixes shorter than 3 letters don't count
    assert rank([a], "the will") == [a]   # only stop words: everything comes back unfiltered


def test_search_ties_go_to_soonest_close():
    late = _m("0xl", "Bitcoin above $100k?", hours=48)
    soon = _m("0xs", "Bitcoin above $90k?", hours=2)
    assert [m.address for m in rank([late, soon], "bitcoin")] == ["0xs", "0xl"]


# ------------------------------------------------------------------ outcomes

def test_outcome_index_by_label_or_number():
    m = _m("0xa", "q", outcomes=("Yes", "No"))
    assert m.outcome_index("yes") == 0 and m.outcome_index(" No ") == 1
    assert m.outcome_index(1) == 1 and m.outcome_index("0") == 0
    with pytest.raises(ValueError):
        m.outcome_index("Maybe")
    with pytest.raises(ValueError):
        m.outcome_index(2)


# ------------------------------------------------------------------ limits

def _guard(tmp_path, **kw) -> Guard:
    return Guard(Limits(**kw), ledger=tmp_path / "spend.json")


def test_trading_off_by_default(tmp_path):
    with pytest.raises(LimitExceeded, match="trading is off"):
        _guard(tmp_path).check("0xa", 1)


def test_per_trade_daily_and_allow_list(tmp_path):
    g = _guard(tmp_path, trading_enabled=True, max_trade_usd=5, max_daily_usd=8, allowed_markets=frozenset({"0xa"}))
    with pytest.raises(LimitExceeded, match="per-trade"):
        g.check("0xa", 6)
    with pytest.raises(LimitExceeded, match="ALLOWED"):
        g.check("0xB", 1)
    g.check("0xA", 5)                 # allow-list is case-insensitive
    g.record(5)
    with pytest.raises(LimitExceeded, match="remaining budget of \\$3.00"):
        g.check("0xa", 4)
    g.check("0xa", 3)
    # the ledger survives a restart
    assert _guard(tmp_path, trading_enabled=True).spent_today() == 5


def test_limits_from_env(monkeypatch):
    monkeypatch.setenv("AGON_ALLOW_TRADING", "true")
    monkeypatch.setenv("AGON_MAX_TRADE_USD", "2.5")
    monkeypatch.setenv("AGON_ALLOWED_MARKETS", "0xA, 0xb")
    lim = Limits.from_env()
    assert lim.trading_enabled and lim.max_trade_usd == 2.5 and lim.allowed_markets == {"0xa", "0xb"}


# ------------------------------------------------------------------ budget fitting

def _lmsr_stub(b: float = 1.0, q=(0.0, 0.0), fee: float = 0.02):
    """Something shaped like Delphi with an exact LMSR cost function (USDC has 6 decimals)."""
    def cost(qs):
        return b * math.log(sum(math.exp(x / b) for x in qs))

    def quote_raw(m, idx, shares_raw, side):
        s = shares_raw / SHARE
        after = list(q)
        after[idx] += s
        return math.ceil((cost(after) - cost(q)) * (1 + fee) * 1e6)

    return SimpleNamespace(network=SimpleNamespace(token_decimals=6), _quote_raw=quote_raw)


@pytest.mark.parametrize("usd", [0.05, 0.5, 3, 20])
def test_fit_budget_never_overspends_and_gets_close(usd):
    stub = _lmsr_stub()
    m = _m("0xa", "q")
    raw, spent = Delphi._fit_budget(stub, m, 0, int(usd * 1e6))
    assert spent <= usd * 1e6
    assert spent >= usd * 1e6 * 0.99
    assert stub._quote_raw(m, 0, raw, "buy") == spent


def test_fit_budget_stops_at_what_the_pool_can_sell():
    stub = _lmsr_stub()
    priced = stub._quote_raw
    def capped(m, idx, raw, side):  # the pool refuses anything above 30 shares
        if raw > 30 * 10**18:
            raise RuntimeError("too many shares")
        return priced(m, idx, raw, side)
    stub._quote_raw = capped
    raw, spent = Delphi._fit_budget(stub, _m("0xa", "q"), 0, int(100_000 * 1e6))
    assert 29.9 * 10**18 <= raw <= 30 * 10**18
    assert spent == priced(_m("0xa", "q"), 0, raw, "buy") < 100_000 * 1e6


def test_fit_budget_too_small():
    stub = SimpleNamespace(network=SimpleNamespace(token_decimals=6), _quote_raw=lambda *a: 10**9)
    with pytest.raises(DelphiError, match="too small"):
        Delphi._fit_budget(stub, _m("0xa", "q"), 0, 1)


# ------------------------------------------------------------------ networks

def test_every_deployment_has_an_abi():
    from agon.chain import abi
    from agon.networks import NETWORKS
    for net in NETWORKS.values():
        for dep in net.deployments:
            names = {x.get("name") for x in abi(dep.kind) if x.get("type") == "function"}
            assert {"getMarket", "marketStatus", "buyExactOut", "quoteBuyExactOut"} <= names, (net.name, dep.name)


# ------------------------------------------------------------------ recording

from agon.recorder import Recorder, belief_vector, to_basis_points  # noqa: E402


@pytest.mark.parametrize("probs", [[0.62, 0.38], [1, 0], [0.333, 0.333, 0.334], [0.999, 0.0005, 0.0005], [5, 3, 2],
                                   [1 / 7] * 7, [0.5] + [0.5 / 40] * 40])
def test_basis_points_always_valid(probs):
    bp = to_basis_points(probs)
    assert sum(bp) == 10000 and all(100 <= b <= 9900 for b in bp) and len(bp) == len(probs)


def test_basis_points_keep_the_shape():
    assert to_basis_points([0.62, 0.38]) == [6200, 3800]
    assert to_basis_points([1, 0]) == [9900, 100]


def test_belief_vector_accepts_one_side_labels_and_lists():
    m = _m("0xa", "q", outcomes=("Yes", "No"))
    assert belief_vector(m, {"Yes": 0.7}) == pytest.approx([0.7, 0.3])
    assert belief_vector(m, {"no": 0.25}) == pytest.approx([0.75, 0.25])
    assert belief_vector(m, {0: 0.6}) == pytest.approx([0.6, 0.4])
    assert belief_vector(m, [0.1, 0.9]) == [0.1, 0.9]
    three = _m("0xb", "q", outcomes=("A", "B", "C"))
    assert belief_vector(three, {"A": 0.5}) == pytest.approx([0.5, 0.25, 0.25])
    with pytest.raises(ValueError):
        belief_vector(m, {"Yes": 0.8, "No": 0.4})
    with pytest.raises(ValueError):
        belief_vector(m, [0.2, 0.3, 0.5])


def test_forecast_signature_recovers_to_the_wallet():
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    key = "0x" + "11" * 32
    r = Recorder(key, url="http://unused")
    msg = {"market": "0x4F5DC6b636c226CeC0C2403f988f24431b9Cc463", "probabilities": [6200, 3800], "issuedAt": 1763190000,
           "visibility": 0, "reasoningHash": "0x" + "00" * 32, "receiptHash": "0x" + "00" * 32, "salt": "0x" + "ab" * 32}
    sig = r._sign("Forecast", msg)
    from agon.recorder import TYPES
    typed = encode_typed_data(full_message={"types": {"EIP712Domain": [{"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                                                                       {"name": "chainId", "type": "uint256"}], "Forecast": TYPES["Forecast"]},
                                            "primaryType": "Forecast", "domain": {"name": "Agon", "version": "1", "chainId": 685689}, "message": msg})
    assert Account.recover_message(typed, signature=sig) == Account.from_key(key).address


# ---------------------------------------------------------------- timelock (drand quicknet, no network)

from agon import tlock  # noqa: E402

ROUND_1000_SIG = bytes.fromhex("b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125"
                               "e342b73a8dd2bacbe47e4b6b63ed5e39")
TLOCK_JS_ROUND_1000 = """-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IHRsb2NrIDEwMDAgNTJkYjliYTcwZTBj
YzBmNmVhZjc4MDNkZDA3NDQ3YTFmNTQ3NzczNWZkM2Y2NjE3OTJiYTk0NjAwYzg0
ZTk3MQppNTN3MStmdko4bEN4UUhMRDM5WS9HdFI1MG9KSFRTUVI3eFRzeENqSTdI
NTJ4UEFCRTJKTUJrWTZTQ1kveHFFCkM0WUtmQnZ1bWEvVzF0ZkMrMm5RMkRpZnRH
YjRHU2szV0JLaE0zZ1V6bXRrdUxwQXUrbUpGSmF5RWY2ODdsdTUKTVl1OTdJay9O
Z3gzN29HY3hYUDA2Tnc1ZnkwYzZBdWQwbThXM0RsZW92UQotLS0gazBjWnVaQTVX
U0xaT1RZbTBVRlc3UXpSS2lkbFNzMk9mUTNDaEhTenVjbwrDZztxZapvbHqSB+Vs
ksRBlNc+yYQJS7Bdm6eoR0VaHrSrBRvOe2GkBBXr4T21NQFUAj9VeuILwPxYC4yY
3pU=
-----END AGE ENCRYPTED FILE-----
"""


def test_drand_rounds_and_beacon_check():
    assert tlock.round_time(1) == tlock.GENESIS
    assert tlock.round_at(tlock.round_time(5000)) == 5000
    assert tlock.round_at(tlock.round_time(5000) + 1) == 5001  # the first round at or after t
    assert tlock.verify_beacon(1000, ROUND_1000_SIG)
    assert not tlock.verify_beacon(1001, ROUND_1000_SIG)


def test_decrypts_what_tlock_js_encrypted():
    assert tlock.parse(TLOCK_JS_ROUND_1000) == (1000, tlock.CHAIN_HASH)
    assert tlock.decrypt(TLOCK_JS_ROUND_1000, signature=ROUND_1000_SIG) == b"made by tlock-js for round 1000"


def test_timelock_roundtrip_and_wrong_round():
    ct = tlock.encrypt(b'{"message": {}, "signature": "0x"}', 1000)
    assert ct.startswith(tlock.ARMOR_HEAD) and tlock.parse(ct)[0] == 1000
    assert tlock.decrypt(ct, signature=ROUND_1000_SIG) == b'{"message": {}, "signature": "0x"}'
    with pytest.raises(tlock.TimelockError):
        tlock.decrypt(tlock.encrypt(b"later", 1001), signature=ROUND_1000_SIG)


def test_leaf_is_digest_then_wallet():
    from eth_utils import keccak
    key = "0x" + "11" * 32
    r = Recorder(key, url="http://unused")
    msg = {"market": "0x4F5DC6b636c226CeC0C2403f988f24431b9Cc463", "probabilities": [6200, 3800], "issuedAt": 1763190000,
           "visibility": 2, "reasoningHash": "0x" + "00" * 32, "receiptHash": "0x" + "00" * 32, "salt": "0x" + "ab" * 32}
    digest = r._typed("Forecast", msg)
    from eth_account.messages import _hash_eip191_message
    d = _hash_eip191_message(digest)
    assert r.leaf_of(msg) == "0x" + keccak(d + bytes.fromhex(r.address[2:])).hex()


def test_locked_signature_recovers_to_the_wallet():
    from eth_account import Account
    key = "0x" + "22" * 32
    r = Recorder(key, url="http://unused")
    locked = {"market": "0x4F5DC6b636c226CeC0C2403f988f24431b9Cc463", "leaf": "0x" + "cd" * 32, "round": 33975412,
              "ciphertextHash": "0x" + "ef" * 32, "issuedAt": 1763190000}
    sig = r._sign("Locked", locked)
    assert Account.recover_message(r._typed("Locked", locked), signature=sig) == r.address


def test_badge_command_prints_markdown(capsys):
    from agon.cli import main
    w = "0x1b563856830c5fd9aa06e42fceeddb6529abc36d"
    assert main(["badge", w]) == 0
    out = capsys.readouterr().out
    assert f"/league/v1/agents/{w}/badge.svg" in out and f"#/agent/{w}" in out and out.startswith("[![Agon record]")


# ---------------------------------------------------------------- starter agent

from agon import agent  # noqa: E402


def _yes_no(**kw):
    return Market(address="0x" + "aa" * 20, deployment="lmsr", mechanism="lmsr", status="open", question="Will it?",
                  outcomes=["Yes", "No"], probabilities=[0.40, 0.60], prices=[0.4, 0.6],
                  trading_closes_at=datetime.now(timezone.utc) + timedelta(days=2), settlement_deadline=None,
                  rules="Resolves Yes if it happens.", sources=["https://example.com/src"], **kw)


def test_parse_forecast_takes_the_last_json_and_clamps():
    m = _yes_no()
    text = 'Thinking {"draft": 1} ... final:\n```json\n{"probabilities": {"yes": 1.0}, "reasoning": "sure", "sources": ["https://a.b", "nope"]}\n```'
    f = agent.parse_forecast(text, m)
    assert f.probabilities["Yes"] == pytest.approx(0.99, abs=1e-3) and sum(f.probabilities.values()) == pytest.approx(1)
    assert f.reasoning == "sure" and f.sources == ["https://a.b"]
    with pytest.raises(ValueError):
        agent.parse_forecast("no json here", m)
    with pytest.raises(ValueError):
        agent.parse_forecast('{"probabilities": {"Maybe": 0.5}}', m)


class _FakeClaude:
    """Stands in for anthropic.Anthropic(): one paused turn, then the answer."""

    def __init__(self):
        self.calls = []
        replies = [
            SimpleNamespace(stop_reason="pause_turn", content=[SimpleNamespace(type="server_tool_use")]),
            SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text='{"probabilities": {"Yes": 0.7, "No": 0.3}, "reasoning": "r", "sources": []}')]),
        ]
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: (self.calls.append(kw), replies.pop(0))[1]))


def test_claude_strategy_resumes_a_paused_turn_and_sends_the_rules():
    fake = _FakeClaude()
    f = agent.claude_strategy("claude-opus-5-5", client=fake)(_yes_no())
    assert f.probabilities == {"Yes": 0.7, "No": 0.3}
    assert len(fake.calls) == 2 and fake.calls[1]["messages"][-1]["role"] == "assistant"
    first = fake.calls[0]
    assert "Resolves Yes if it happens." in first["messages"][0]["content"] and "https://example.com/src" in first["messages"][0]["content"]
    assert {t["type"] for t in first["tools"]} == {"web_search_20260209", "web_fetch_20260209"}
    assert first["fallbacks"] == "default"


class _FakeDelphi:
    def __init__(self, m):
        self.m, self.bought, self.forecasts = m, [], []

    def market(self, addr):
        return self.m

    def buy(self, m, idx, *, usd, belief, reasoning):
        self.bought.append((idx, usd, belief))
        return SimpleNamespace(usd=usd, tx_hash="0xt", explorer_url="x", record={"entry": 9, "commit_tx": "0xc"})

    def forecast(self, m, belief, reasoning, public=False):
        self.forecasts.append((belief, reasoning, public))
        return SimpleNamespace(id=8, timelocked=not public, url="u")


def test_run_forecasts_by_default_and_trades_only_past_the_edge():
    m = _yes_no()
    strat = lambda _m: agent.Forecast({"Yes": 0.55, "No": 0.45}, "evidence", ["https://s"])  # noqa: E731
    d = _FakeDelphi(m)
    out = agent.run(d, strat, [m.address], agent.Plan(trade=True, min_edge=0.20), log=lambda s: None)
    assert out[0]["entry"] == 8 and out[0]["timelocked"] and not d.bought  # edge 15 points < 20
    assert "Sources: https://s" in d.forecasts[0][1]
    out = agent.run(d, strat, [m.address], agent.Plan(trade=True, min_edge=0.10, max_usd=2), log=lambda s: None)
    assert d.bought == [(0, 2, {"Yes": 0.55, "No": 0.45})] and out[0]["commit_tx"] == "0xc"
    out = agent.run(d, strat, [m.address], agent.Plan(dry_run=True), log=lambda s: None)
    assert out[0]["recorded"] is False and len(d.forecasts) == 1


def test_run_skips_markets_about_to_close():
    m = _yes_no()
    m.trading_closes_at = datetime.now(timezone.utc) + timedelta(minutes=20)
    out = agent.run(_FakeDelphi(m), lambda _m: 1 / 0, [m.address], agent.Plan(min_hours_left=1), log=lambda s: None)
    assert "skipped" in out[0]
