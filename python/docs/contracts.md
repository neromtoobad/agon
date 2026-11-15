# Delphi on Gensyn mainnet: contract notes

These are notes for anyone calling Delphi contracts directly. Everything here was checked against mainnet
(chain 685689) in November 2026, and the trading paths against a local fork of it (`tests/test_fork.py`).

## Three deployments

| name in Agon | mechanism | factory | gateway | markets |
|---|---|---|---|---|
| `lmsr` | LMSR market maker | `0x1819a2aeEb96DA9BA1C5262A5c82B6F9c347f99c` | `0x7fd914D05D1FE4Fa3EC84E2Cd1D81be6CBe03747` | 202 |
| `dpm` | dynamic parimutuel, oracle-settled | `0x9C73417f79a1361c6aF9Bd828343badEE1b84936` | `0x982a67aE92D8de361957249fB2BB4a62BCc6A8d5` | 479 |
| `dpm-legacy` | dynamic parimutuel, first generation | `0x4596d847eA56DCf9A37944c13793Af802Fc5D1eC` | `0x4e4e85c52E0F414cc67eE88d0C649Ec81698d700` | 346 |

The collateral is USDC at `0x5b32c997211621d55a89Cc5abAF1cC21F3A6ddF5`, with 6 decimals. Multicall3 is at the
usual `0xcA11bde05977b3631167028862bE2a173976CA11`.

- To find which deployment a market belongs to, ask each factory `marketProxyExists(market)`. All calls about a
  market must go through that deployment's gateway.
- To enumerate markets, call `getTotalMarketProxiesCount()` and then `getMarketProxies(from, to)` on each
  factory. The legacy factory returns lowercase addresses, so checksum them before passing them to web3.

The official TypeScript SDK (2.1.0) configures only the two DPM rows for mainnet.

The agent-competition network (Gensyn testnet, factory `0xEa9D0a78d0209916e88e363B8FDa3e23206Ff49b`, gateway
`0x097599c9D966fF496284b892A8F13BF885b258ef`, 210 markets) runs an **earlier LMSR version**. Its `getMarket`
config has no `earliestResolveTime`, so mainnet's LMSR ABI fails to decode it. Agon calls it `lmsr_v1`.

## Where they differ

**Quotes and trades return different shapes.**

- LMSR `quoteBuyExactOut`, `quoteSellExactIn`, `buyExactOut` and `sellExactIn` return
  `(tokens, outcomeNewExp, newExpSum)`.
- DPM returns a single `uint256`.

Code that decodes one number fails on every LMSR market. For LMSR, the probability after a trade is
`outcomeNewExp / newExpSum`.

**`getMarket(market).config` has different fields.**

- LMSR: `outcomeCount, b, tradingFee, tradingDeadline, earliestResolveTime, settlementDeadline`.
- DPM: `outcomeCount, k, tradingFee, tradingDeadline, settlementDeadline`.

**Resolution.** The legacy gateway has no `resolveMarket`.

- On `lmsr` and `dpm`, anyone can call `resolveMarket` once trading has closed (LMSR also waits for
  `earliestResolveTime`). This asks the Truebit oracle relayer to run the judge.
- Only the relayer can call `settleMarket` or `failMarket`.
- A market nobody settles before `settlementDeadline` becomes `expired`.

## Approvals: approve the market, not the gateway

You send trades to the gateway, but the **market contract pulls the USDC**. If you approve the gateway, every buy
reverts with `ERC20: transfer amount exceeds allowance`. This is true on all three deployments. Agon
approves the market for exactly the trade's maximum cost; pass `approve_unlimited=True` to change that.

## Statuses and units

- `marketStatus` returns `0 open, 1 awaiting_settlement, 2 settled, 3 expired, 4 failed`.
- Shares use 18 decimals.
- `spotImpliedProbabilities` uses 1e18 = 100%.
- `spotPrices` is in token units (6 decimals).
- `tradingFee` uses 1e18 = 100%; the factory allows 0.5%–5%.

## After the market closes

- **settled:** `redeem(market)` pays winning shares and returns `(sharesIn, tokensOut)`. Simulating it from the
  holder's address tells you the payout without sending anything.
- **expired or failed:** `liquidate(market, outcomeIndices)` pays shares at their final prices. This is not a
  refund at cost: in the fork test, $1 of a long shot came back as $1.33.

## Rules files

`marketMetadata(market)` returns `(uri, contentHash)`.

- The URI points to a JSON file with `question`, `outcomes`, the judge's `model` and `prompt_context` (the rules),
  `data_sources`, and dates.
- On current markets `contentHash` is the sha256 of the file, and on some older ones it's keccak256.
- Agon checks both and sets `Market.metadata_verified`.

## What isn't public

- The Goldsky subgraph (`delphi-mainnet-autoset`) indexes only the `dpm` deployment, so LMSR has no public price
  history.
- The REST API (`api.delphi.fyi`) needs a key, and it is the only source of the app's market IDs, which are used
  in `delphi.fyi` links.

Agon doesn't depend on either.
