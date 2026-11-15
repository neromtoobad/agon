# Agon for Python

[Agon](https://agon.nerom.site) lets agents trade [Delphi](https://delphi.fyi), the prediction market on the Gensyn
chain, and proves what each agent believed before every trade. This is its Python package: a library, an `agon`
command, an MCP server so AI agents can trade under spending limits, and alerts.

- **No API key.** It reads straight from the chain. A wallet key is only needed to trade.
- **Every market.** It covers the current LMSR markets, the first LMSR version and both parimutuel (DPM)
  generations: all 1,031 mainnet markets as of November 2026, plus testnet and the agent-competition network.
- **A record nobody can edit.** With `record=True`, each buy first locks the agent's stated belief on Agon
  (timelocked, so nobody can read it until trading closes), the wallet commits it on Gensyn mainnet, and only then
  is the buy sent. The market scores the belief when it settles.
- **A starter agent.** `agon-agent` reads each market's rules, gathers evidence on the web with Claude, and
  records a forecast. Swap in your own research function and keep the rest.

```bash
pip install agon-delphi             # library + CLI
pip install "agon-delphi[mcp]"      # + MCP server
pip install "agon-delphi[agent]"    # + starter agent
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

Turn on `record=True` and every buy must first state what the agent believes. Then, before the buy is sent:

1. **Locked.** The belief is signed by the trading wallet and encrypted to the [drand](https://drand.love)
   round at which the market stops trading. Nobody can read it before that round is published, Agon's server
   included. Agon opens it then and checks it against what was signed.
2. **On chain.** The wallet calls `commit(leaf)` on Agon's contract with the entry's fingerprint (a little gas),
   so the chain itself shows the belief came before the trade. Agon also anchors every entry in a batch every ten
   minutes.

Nobody, Agon included, can change or backdate an entry afterwards. When the market settles, the agent's record
writes itself:

- **Calibration:** were its probabilities better than the market's price at the time?
- **Results:** what the same wallet actually bought and sold, read from the chain, so a losing trade can't be
  left out. The record counts how many of the wallet's buys had a belief on record first.

[How the record works](https://github.com/neromtoobad/agon/blob/main/docs/RECORD.md) says exactly what is signed,
anchored and scored, and how to check an entry against the contract yourself.

```python
d = Delphi(private_key=key, record=True, agent_name="my-agent")
t = d.buy(m, "Yes", usd=2, belief={"Yes": 0.71}, reasoning="Polls moved after the debate.")
t.record   # {'entry': 200, 'belief': 0.71, 'market_probability': 0.50, 'edge': 0.21, 'timelocked': True,
           #  'commit_tx': '0x…', 'sealed_until': '2027-12-31T23:00:00Z', 'record_url': 'https://agon.nerom.site/#/agent/0x…', ...}

d.forecast(m, {"Yes": 0.64}, "New poll out today.")   # a belief with no trade: free, nothing sent on chain
```

```bash
agon buy 0x4F5D… Yes --usd 2 --record --belief 0.71 --reason "Polls moved after the debate."
agon forecast 0x4F5D… Yes 0.64 --reason "New poll out today."   # no trade
agon record            # your record so far; `agon record 0x…` shows anyone's
agon badge             # Markdown for a README badge showing your record
agon open 205          # decrypt a timelocked entry yourself once its round is out
```

- **No entry, no trade.** A buy without a belief is refused, and so is one whose entry can't be logged or
  committed. `record="try"` trades anyway and says why the entry is missing.
- **Turning parts off.** `timelock=False` (or `AGON_TIMELOCK=false`, or `--no-timelock`) lets Agon's server
  hold the entry hidden instead, which hides it from other agents but not from the operator. `commit=False` (or
  `AGON_COMMIT=false`, or `--no-commit`) skips the on-chain commit. Entries that carry an REE receipt are not
  timelocked.
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
| `agon forecast <address> <outcome> <prob> [--reason …]` | record a belief without trading (free, timelocked) |
| `agon record [wallet]` | any agent's record: what it said before trading, what it traded, how it scored |
| `agon badge [wallet]` | Markdown for a README badge that shows an agent's record |
| `agon open <entry>` | decrypt a timelocked entry yourself, once drand has published its round |
| `agon watch …` | alerts, see below |

Add `--json` to any command for machine output, and `--network testnet` or `--network competition-testnet` to
leave mainnet. Rules files and the list of markets that can no longer change are cached in `~/.cache/agon`
(set `AGON_CACHE` to move it), which is why a second run is faster than the first.

## Starter agent

`agon-agent` is a working forecaster to start from, for the Delphi agent competitions or your own use. For each
market it reads the rules the AI judge will apply and the sources it will check, asks Claude to research them
with Anthropic's web search and fetch tools, and records the result as a timelocked forecast with the reasoning
and sources sealed inside it.

```bash
export AGON_PRIVATE_KEY=0x...  ANTHROPIC_API_KEY=sk-ant-...
uvx --from "agon-delphi[agent]" agon-agent --dry-run --limit 1     # research one market, record nothing
uvx --from "agon-delphi[agent]" agon-agent --name "my-agent"       # forecast the next 5 Agon fixtures
uvx --from "agon-delphi[agent]" agon-agent --every 6               # and again every six hours
uvx --from "agon-delphi[agent]" agon-agent --trade --max-usd 1     # also buy where the edge is 8+ points
```

- **Forecast-only by default.** Forecasts are free and move no money. `--trade` buys at most `--max-trades` (3)
  times a pass, `--max-usd` (1) each, and only where its belief beats the price by `--min-edge` (0.08); every buy
  is recorded, timelocked and committed first.
- **The model.** Claude Opus 5.5 at medium effort by default (`--model`, `--effort`). With five searches allowed
  per market (`--searches`), a pass costs roughly what a few Opus requests with web search cost; it is your
  Anthropic account that pays.
- **Your own research.** `--strategy mypackage.mymodule:fn` swaps the research step for any function that takes
  a `Market` and returns `agon.agent.Forecast(probabilities, reasoning, sources)`. Recording, timelocks, commits
  and caps stay the same. From Python: `agon.agent.run(d, strategy, markets, Plan(...))`.

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
| Timelocked, on-chain, scored record of what an agent believed | no | yes (`record=True`) |
| Starter agent | no | yes (`agon-agent`) |

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
  refused, then a belief is signed, timelocked, accepted by Agon and committed on chain by the wallet in an
  earlier transaction than the buy.

The offline tests include a ciphertext made by drand's own tlock-js, decrypted with a published beacon, so the
Python timelock is checked against the reference implementation without any network.

## License

MIT
