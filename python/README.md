# Agon for Python

[Agon](https://agon.nerom.site) lets agents trade [Delphi](https://delphi.fyi), the prediction market on the Gensyn
chain, and proves what each agent believed before every trade. This is its Python package: a library, an `agon`
command, an MCP server so AI agents can trade under spending limits, and alerts.

- **No API key.** It reads straight from the chain. A wallet key is only needed to trade.
- **Every market.** It covers the current LMSR markets, the first LMSR version and both parimutuel (DPM)
  generations: all 1,031 mainnet markets as of November 2026, plus testnet and the agent-competition network.
- **A record nobody can edit.** With `record=True`, each buy first seals the agent's stated belief on Agon,
  anchored on Gensyn mainnet, and the market scores it when it settles.

```bash
pip install agon-delphi           # library + CLI
pip install "agon-delphi[mcp]"    # + MCP server
```

## Find a market and price a trade

```console
$ agon search bitcoin --limit 3
0x44CF6d128e086961b7c0844dE6285c75046d7B7C  Dec 25 05:00  $  27.85  Yes 17%  No 83%
    Will Bitcoin exceed $100,000 by Christmas 2026?
0x662Bba4819098F000d33d1e09Dff5dC3C3a5aa87  Dec 31 00:00  $  19.11  Yes 33%  No 67%
    Will Bitcoin's Coinbase BTC-USD price be above $80,000 at 00:00 UTC on Dec 31, 2026?
0xc43F7318bf91915dba2A3A02489bdEd2aDC1731f  Jan 01 02:00  $  39.52  Yes 22%  No 78%
    Will Bitcoin reach $100k in 2026?

$ agon quote 0x4F5DC6b636c226CeC0C2403f988f24431b9Cc463 Yes --usd 5
buy 7.7223 Yes shares costs $4.9996 (avg 0.6474); probability 50.4% → 75.3%
```

Most Delphi pools hold $10–$50, so a $5 trade can move the price 25 points. On LMSR markets (most open ones) a
quote shows the probability after your trade, so you see that before you pay. If a budget is more than the pool
can sell, the quote says so and shows the most it can.

`agon market <address>` prints the rules the AI judge will apply and the sources it will read. It also checks
that the rules file matches the hash stored on chain.

## Record what your agent believed

Turn on `record=True` and every buy must first state what the agent believes. That belief is signed by the
trading wallet, sealed until trading closes, and anchored on Gensyn mainnet by Agon's contract.
Other agents can't read it before then, and nobody, Agon included, can change or backdate it afterwards.
When the market settles, the agent's record writes itself:

- **Calibration:** were its probabilities better than the market's price at the time?
- **Results:** what the same wallet actually bought and sold, read from the chain, so a losing trade can't be
  left out. The record counts how many of the wallet's buys had a belief on record first.

[How the record works](https://github.com/neromtoobad/agon/blob/main/docs/RECORD.md) says exactly what is signed,
anchored and scored, and how to check an entry against the contract yourself.

```python
d = Delphi(private_key=key, record=True, agent_name="my-agent")
t = d.buy(m, "Yes", usd=2, belief={"Yes": 0.71}, reasoning="Polls moved after the debate.")
t.record   # {'entry': 200, 'belief': 0.71, 'market_probability': 0.50, 'edge': 0.21,
           #  'sealed_until': '2027-12-31T23:00:00Z', 'record_url': 'https://agon.nerom.site/#/agent/0x…', ...}
```

```bash
agon buy 0x4F5D… Yes --usd 2 --record --belief 0.71 --reason "Polls moved after the debate."
agon record            # your record so far; `agon record 0x…` shows anyone's
```

- **No entry, no trade.** A buy without a belief is refused, and so is one whose entry can't be logged.
  `record="try"` trades anyway and says why the entry is missing.
- **When it's logged.** The entry is sent after the trade has been simulated and just before it is sent, so a buy
  that would fail leaves no entry.
- **What it covers.** Mainnet markets whose trading window was at least 12 hours long; shorter ones are refused.
- **Which server.** Entries go to https://agon.nerom.site. The server is in this repo; point `recorder_url`
  or `AGON_URL` at your own instance if you run one.
- **In the MCP server.** Set `AGON_RECORD=true` (plus `AGON_AGENT_NAME`) and the `buy` tool requires the
  agent's `probability` and `reasoning`. `my_record` shows what it has logged and, after settlement, how it scored.
- **Proof for the model, too.** An entry can carry a receipt from Gensyn's REE (`receipt=`)
  proving which open model produced the forecast. Agon re-runs receipts on a second machine.

## Library

```python
from agon import Delphi

d = Delphi()                                   # mainnet, read-only
for m in d.search("bitcoin", limit=5):
    print(m.summary())

m = d.market("0x4F5DC6b636c226CeC0C2403f988f24431b9Cc463")
print(m.rules, m.sources, m.metadata_verified)

q = d.quote_buy(m, "Yes", usd=2)               # shares, average price, probability before/after
print(q.shares, q.average_price, q.probability_after)

d = Delphi(private_key="0x...")                # or set AGON_PRIVATE_KEY
t = d.buy(m, "Yes", usd=2)                     # never spends more than usd; approves only what this trade needs
d.sell(m, "Yes")                               # everything you hold in that outcome

for p in d.positions():                        # every market, with what to do next
    print(p.question, p.outcome_label, p.shares, p.value_usd, p.action)  # action: redeem | liquidate | None
```

You can pass an address or a `Market` anywhere one is expected, and outcomes take a label (`"Yes"`) or an index.
Money comes back as USD floats and shares as decimal numbers; every object has `.to_dict()`.

## Command line

| command | does |
|---|---|
| `agon markets [--status open\|settled\|…\|all]` | list markets with live odds, soonest to close first |
| `agon search <words>` | keyword search over questions, outcomes and rules |
| `agon market <address>` | one market in full: rules, sources, deadlines, fee, hash check |
| `agon quote <address> <outcome> --usd N \| --shares N \| --sell N` | price a trade, send nothing |
| `agon buy <address> <outcome> --usd N` | buy (asks you to type `yes` first unless `--yes`) |
| `agon sell <address> <outcome> [--shares N]` | sell, default everything |
| `agon positions [wallet]` | what a wallet holds and can collect |
| `agon collect <address>` | redeem a settled market, or liquidate an expired or failed one |
| `agon balance` | your USDC and gas |
| `agon record [wallet]` | any agent's record: what it said before trading, what it traded, how it scored |
| `agon watch …` | alerts, see below |

Add `--json` to any command for machine output, and `--network testnet` or `--network competition-testnet` to
leave mainnet. Rules files and the list of markets that can no longer change are cached in `~/.cache/agon`
(set `AGON_CACHE` to move it), which is why a second run is faster than the first.

## MCP server: let an agent trade, with limits

Claude Code:

```bash
claude mcp add agon -- uvx --from "agon-delphi[mcp]" agon-mcp
```

Claude Desktop, Cursor, or anything else that speaks MCP over stdio:

```json
{
  "mcpServers": {
    "agon": {
      "command": "uvx",
      "args": ["--from", "agon-delphi[mcp]", "agon-mcp"],
      "env": {
        "AGON_PRIVATE_KEY": "0x...",
        "AGON_ALLOW_TRADING": "true",
        "AGON_MAX_TRADE_USD": "2",
        "AGON_MAX_DAILY_USD": "10"
      }
    }
  }
}
```

The read tools are `list_markets`, `get_market`, `quote_buy`, `quote_sell`, `get_positions`, `wallet_status` and `my_record`.
The write tools are `buy`, `sell` and `collect`.

Without a key or `AGON_ALLOW_TRADING=true` the server is read-only, and the write tools say so instead of
sending anything. With trading on, every buy is checked first:

| setting | default |
|---|---|
| `AGON_MAX_TRADE_USD` | 5 per trade |
| `AGON_MAX_DAILY_USD` | 20 per UTC day, kept in a ledger file so a restart doesn't reset it |
| `AGON_MAX_SLIPPAGE` | 0.03 |
| `AGON_ALLOWED_MARKETS` | all (comma list of addresses the agent may buy in) |

Use a separate wallet for the agent and only put in what you're willing to lose.

## Alerts

Delphi has no notifications or webhooks, so `agon watch` polls the chain and tells you about:

- new markets
- moves of 10 points or more (`--move`)
- markets about to close (`--closing-hours`)
- markets that close, settle (with the winner), fail or expire
- money your wallet can now collect (`--wallet`)

```bash
agon watch --query "bitcoin" --telegram            # TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
agon watch --wallet 0xYou --webhook https://…      # each alert POSTed as JSON
agon watch --json --once                           # one pass, JSON lines (for cron)
```

The first run records a baseline, and alerts start from the second check.

## What this does that the official SDK doesn't

[`@gensyn-ai/gensyn-delphi-sdk`](https://www.npmjs.com/package/@gensyn-ai/gensyn-delphi-sdk) 2.1.0 is TypeScript
only. Its mainnet config has the two DPM deployments but **not the LMSR one**, and LMSR is where most open markets
are (56 of 82 when this was written). The SDK can reach those markets if you find and pass the gateway and factory
addresses yourself. LMSR quote functions also return three values where DPM returns one. Full
notes are in [docs/contracts.md](https://github.com/neromtoobad/agon/blob/main/python/docs/contracts.md).

| | SDK 2.1.0 | Agon for Python |
|---|---|---|
| Language | TypeScript | Python |
| Mainnet LMSR markets | not in its default config (you must pass the gateway and factory yourself) | yes |
| List markets and positions without an API key | no (REST API needs a key) | yes, from chain |
| Keyword search | no (category filter only) | yes |
| Rules-file hash check | no | yes |
| Buy with a dollar budget | no (exact shares) | yes, never over budget |
| Default approval | unlimited | exact amount |
| Agent spending limits | no | yes |
| Alerts | no | yes |
| Sealed, scored record of what an agent believed | no | yes (`record=True`) |

## Tests

```bash
uv run pytest tests/test_unit.py      # offline, about a second
uv run pytest tests/test_fork.py -s   # needs Foundry's anvil, about a minute, no real money
```

The fork tests run a private copy of Gensyn mainnet and put a throwaway wallet through two full lifecycles:

- **LMSR:** buy with a $3 budget, sell half, jump the clock past the deadline, settle as Delphi's oracle relayer,
  redeem the winnings.
- **DPM:** buy, let the market expire unsettled, liquidate.
- **Record** (with `AGON_TEST_URL` pointing at a local Agon server): a buy without a belief is
  refused, then a belief is signed, accepted by Agon and sealed before the buy is sent.

## License

MIT
