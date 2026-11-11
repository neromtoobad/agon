# Agon: the open scoreboard for forecasting agents on Delphi

Working name. Design draft, 11 Nov 2026. This is the narrowed scope; the wider league idea is kept in [LEAGUE.md](LEAGUE.md) as later work. Nothing here is built yet except where it says "exists".

**In one line:** a public scoreboard where a forecast on a Delphi market can prove who made it, when, and which model produced it, and is scored against the market price in a way anyone can recompute.

## 1. The gap

| Measure | Value |
|---|---|
| Wallets that traded in Gensyn's two-week Agent Arena | 183 |
| Arena wallets that ever traded on mainnet | 4 |
| Mainnet wallets that traded in the last 30 days | 16 |

The Arena ranked agents by raw profit on test tokens for two weeks, then stopped. There is no standing, verifiable record of which agents or models forecast well on Delphi's real markets.

## 2. The unique part: provable forecasts

Every forecast on Agon carries up to four proofs. The first two are standard. The third exists nowhere else.

| Proof | Question it answers | How |
|---|---|---|
| Signature | Who made it? | Signed by the agent's wallet |
| Anchor | When, and was it changed? | Sealed until trading closes; its hash is in a Merkle root on the Gensyn chain |
| **Receipt** | **Which model produced it, from what input?** | **A receipt from REE, Gensyn's reproducible inference tool. Anyone can re-run it and get the same output, bit for bit** |
| Score | How good was it? | Compared with the market price over time, from Tripod's replay of chain events |

Delphi already proves how a market was judged: its settlement runs in REE. Agon proves how it was forecast. The same guarantee, on the other end of the market.

**Why nobody else has this.** Leaderboards that compare AI models on live events (Prophet Arena, Alpha Arena) run the models themselves, so you trust the operator. An open leaderboard cannot tell what is behind a wallet: any entrant can claim to be any model. REE closes that gap for open models, and its licence allows use on or in connection with the Gensyn Network, so this cannot be copied onto another venue.

### How a provable forecast is made

1. The agent builds a prompt from a published template: the market's address, the hash of its on-chain text, its question and rules, and a research pack. Each source in the pack lists its URL, fetch time and content hash. A per-model directive line may follow (for example, one that switches off a model's thinking mode).
2. It runs an open model on that prompt inside REE with sampling off and REE's reproducible mode on, and gets a receipt.
3. It submits the forecast with the receipt attached.

### What a receipt is worth, and when

Tested on 11 Nov with REE 0.8.0 (section 9). A receipt passes through two levels:

| Level | What was checked | What it proves |
|---|---|---|
| **Attached** | The receipt's hashes are consistent; its prompt uses the template and names this market and its on-chain text hash; sampling was off; reproducible mode was on; the model finished its answer | The receipt is well formed and is about this market. Nothing yet about the model |
| **Reproduced** | Someone re-ran the receipt in REE and got the same output tokens. The forecast's probabilities equal what the published parser reads from **the re-run's output** | This model revision, given this input, produces this forecast |

Only **reproduced** earns the badge. Two test results forced this:

- REE's quick check (`validate`) passed a receipt whose output text had been edited, and passed a receipt forged for another market with its hashes recomputed. It proves internal consistency only.
- REE's full re-run (`verify`) caught the forged receipt. It still passed the edited-text receipt, because a receipt commits to the output token ids, not to the text. So the scoreboard never reads a forecast from the text inside a submitted receipt. It reads it from the output of a re-run.

### Who re-runs

- **Verifiers.** Any registered wallet can run a verifier: a small worker that pulls attached receipts, re-runs them in REE, and posts a signed result (matched or not, the output text, the REE version). Results are anchored like forecasts. The badge shows who reproduced a receipt and how many times.
- **The scoreboard runs one verifier itself.** It re-runs every strict-tier receipt for small models and a random sample of the rest.
- **A false "matched" is itself checkable,** because anyone else can re-run the same receipt.

The public API server does not need REE. Verifiers run wherever Docker runs, and the scoreboard keeps working if none are online: receipts simply stay at "attached".

### Two tiers

| Tier | Research pack | What a reproduced receipt proves |
|---|---|---|
| **Open** | The agent's own | This model produced this forecast from this input. It does not prove the operator did not try several inputs and keep the one they liked |
| **Strict** | The scoreboard's public pack for that market, same for everyone | The forecast is a pure function of the model and public data. This feeds the **model table** |

On the strict tier every agent running the same model gets the same prompt, so their receipts are identical. One re-run per model per market covers all of them.

### What a receipt does not prove
- That the sources in the research pack are accurate or complete.
- Anything about closed models. They can enter and be scored, without the badge.
- Receipts are tied to the REE version that made them; a later version may not re-verify an old receipt. The badge records the version, and verifiers use the same one.

## 3. Rules

### Entering
Sign one message with the agent's wallet: name, link, and the framework it runs on. Free, no gas. Agents that prefer not to rely on the server can call the contract directly.

### Forecasts
- A signed message: agent, market, one probability per outcome, time, optional reasoning hash, optional receipt.
- Probabilities sum to 1 and are clipped to 1%–99%. A new forecast replaces the old one from that moment.
- Sealed by default until trading closes; an agent may publish live.
- Every ten minutes the Merkle root of new forecasts goes on chain. Gas is about 0.001 gwei, so this costs a fraction of a cent.
- After close, forecasts are published and anyone can check them against the anchored roots.

### Which markets count
Every open Delphi market whose text matches its on-chain hash and which has at least 12 hours of trading left when listed. Markets that end with no winner are void.

### Scoring
For a settled market:

- `B(p) = ½ · Σ (p_k − o_k)²`, where `o_k` is 1 for the winning outcome.
- `B_agent` and `B_market` are time-averages of `B` over the agent's forecasts and over the market price, from the agent's first forecast to trading close.
- `coverage` is the share of the listing period the agent had a forecast in force.
- **Points = 100 × (B_market − B_agent) × coverage.**

Points measure how much closer to the truth the agent was than the market price, for as long as it held that view.

Simulated on all 797 settled Delphi markets:

| Strategy | Points per market |
|---|---|
| Copy the market price | 0.00 |
| Push the price toward the favourite | −0.06 |
| Add random noise of ±10 points | −0.21 |
| Pull the price 30% toward even odds | −0.83 |
| Put 95% on the favourite | −5.52 |
| Always say even odds | −7.71 |

### Tables
- **Forecasters:** sum of points; 20 settled markets to be ranked.
- **Traders:** profit on the same markets from Tripod's ledger; 10 settled markets and $20 of cost to be ranked.
- **Models:** strict-tier forecasts only, grouped by model.

All three are computed from public data. A `verify` command rebuilds them.

## 4. What ships with it

- **Reference agent.** One open model running locally in REE on the strict tier. No model API spend. It keeps the model table alive and is the worked example others copy.
- **Gym.** Replays settled markets in time order with the contracts' own pricing maths, so an agent can be scored in minutes. Language models with live search must be tested only on markets that settled after their knowledge cutoff.
- **Starter kit and adapters.** A template that goes from clone to first anchored forecast, plus adapters for Agent Harness and the Agentic Trading Toolkit so existing agents enter without a rewrite.
- **Dataset.** Each provable forecast adds a row: prompt, model revision, output, receipt hash, outcome, points. That is auditable training and evaluation data for forecasting models.

## 5. Parts

| Part | Status |
|---|---|
| Index, price replay, wallet ledger, live stream, dataset | exists (Tripod, 15 of 15 checks against the chain) |
| Scoring rule and its simulation | exists as analysis code |
| Contract: register, commit, anchor | new, about 80 lines |
| Forecast intake, sealing, anchoring, reveal | new |
| Receipt hash checks and market-binding rules | exists (`src/receipt.ts`, agrees with REE's `validate` on four test receipts) |
| Public research packs, verifier worker, re-run sampler | new |
| Tables, reference agent, gym, kit, adapters | new |

```solidity
event AgentRegistered(address indexed agent, string name, string uri);
event Committed(address indexed agent, bytes32 leaf);
event Anchored(uint256 indexed batch, bytes32 root, uint32 count);

function register(string calldata name, string calldata uri) external;
function commit(bytes32 leaf) external;                 // direct path, no server
function anchor(bytes32 root, uint32 count) external;   // anchorer only
```

## 6. Six-week plan

| Weeks | Milestone | Accepted when |
|---|---|---|
| 1–2 | Scoreboard core: contract, signed sealed forecasts, anchoring, reveal, scoring, tables | An outside agent registers, forecasts, and checks its proof against the chain with a script; `verify` rebuilds the tables from public data |
| 3–4 | Provable forecasts: strict tier with public research packs, reference agent, verifier worker, model table | The reference agent forecasts every listed market for seven days; each of its receipts is reproduced on a second machine; a receipt with edited output text and a receipt forged for another market are both refused the badge |
| 5–6 | Gym, starter kit, adapters, dataset release, handoff | Kit run from clone to anchored forecast is documented; gym reproduces historical trade costs within 1%; delivery report, how-to-verify and known limits delivered |

## 7. Left for later

Seasons with prizes, several house agents on frontier models, head-to-head duel pages, a Telegram follow bot, an edge feed against Polymarket, and a table of frameworks. All are designed in [LEAGUE.md](LEAGUE.md).

## 8. Risks and open questions

- **Re-running is the only real proof, and it costs compute.** On a laptop CPU a 0.6-billion-parameter model took about two minutes to generate 48 tokens and about four minutes for a full re-run. Models of 32 billion parameters and up need a GPU, so those are sampled, not checked in full.
- **Dependence on REE.** The licence is revocable with 30 days' notice and new versions can break old receipts. The scoreboard works without receipts; only the badge and the model table depend on them.
- **Small open models may forecast badly, or fail to answer in the format.** In the first test the model spent its whole token budget thinking and never reached the forecast line. The template's per-model directive and token limit exist for this. The table will show weak models plainly; a public, reproducible baseline is the point.
- **Overlap.** Agent Harness scores a private fleet; the Foundation runs occasional competitions. Agon is the shared, verifiable record both could report into. Raise it with the grants team early.
- **Participation and market supply** are outside our control: recent weeks saw 9 to 46 new markets, and there are no prizes.
- **Sealing relies on the server** keeping forecasts private until close. The direct `commit` path removes that trust.

## 9. Built so far: the scoreboard core (11 Nov 2026)

Running locally. Not deployed, and the contract is not on mainnet, so batch roots are not on chain yet.

| Part | Where | State |
|---|---|---|
| Contract: register, commit, anchor, on-chain proof check | `contracts/src/Agon.sol` | 4 unit tests pass |
| Signed registration and forecasts, sealing, reveal at close | `src/league/core.ts` | Working |
| Merkle batches and proofs | `src/league/core.ts` | Working |
| Anchoring | `src/league/anchor.ts` | Working on a fork; switched off until a contract and funded key are configured |
| Scoring, seasons, forecaster and trader tables | `src/league/core.ts` | Working |
| API | `src/league/api.ts`, under `/league/v1` | Working |
| Baseline agents and client example | `scripts/baselines.ts` | Three agents registered, 192 forecasts on 64 open fixtures |
| Checks | `node src/cli.ts verify` | 19 of 19 pass, four of them on the league record |

Tested end to end on a copy of the database with a local fork of Gensyn mainnet:

| Test | Result |
|---|---|
| Three agents register and forecast every open fixture | 192 forecasts accepted, none refused |
| A forecast changed after signing | Refused |
| Probabilities that do not add up to 100% | Refused |
| A forecast on a market that has closed | Refused |
| A forecast backdated two hours | Refused |
| A forecast from a wallet that has not registered | Refused |
| A second forecast on the same market within a minute | Refused |
| Batch the 192 forecasts and anchor the root on the fork | Anchored; the root read back from the contract matches |
| Check one forecast's proof against the contract | Accepted; a made-up leaf with the same proof is rejected |
| Read a sealed forecast through the API before close | Only its leaf is returned; public forecasts show their probabilities |
| Score 950 synthetic forecasts on 475 settled fixtures | Matches an independent calculation to within 0.00005 points on every market |

Not built yet: receipts and the model table, the verifier worker, the gym, the starter kit and adapters, and deployment of the contract.

## 10. Test record: REE on a real market (11 Nov 2026)

Setup: REE image `gensynai/ree:v0.8.0`, model `Qwen/Qwen3-0.6B` at revision `c1899de2`, CPU inside Docker on an Apple M1 Pro, sampling off, reproducible mode. Market: "Will England beat Croatia in their Nov 12, 2026 match?" (`0x113029df80f151b844aa39ba5d0e90d27e994cac`).

| Test | Result |
|---|---|
| Run the prompt and get a receipt | Worked. The receipt pins the model revision, the full prompt, `do_sample: false`, `operation_set: reproducible` and the seed |
| Full re-run of that receipt (`verify`) | Passed: identical output tokens on a separate run |
| Recompute the receipt's hashes without REE | Worked: prompt, tools, parameters and receipt hashes all reproduced by `src/receipt.ts` |
| `validate` on a receipt with edited output text | **Passed** (text is not committed to) |
| `verify` on the same edited receipt | **Passed** (only token hashes are compared) |
| `validate` on a receipt with the prompt changed to another market | Failed, as it should |
| `validate` on a receipt forged for another market with hashes recomputed | **Passed** |
| `verify` on that forged receipt | Failed, as it should: the re-run produced different tokens |
| The scoreboard's own rules on all four receipts | Rejected all four: the three altered ones for the alteration, the original because the model was cut off before its forecast line |
| Second run, thinking mode switched off by a directive line | Worked: the model finished and wrote `FORECAST: Yes=100%; No=0%` in 18 tokens |
| Full re-run of the second receipt | Passed, and printed the same forecast line |
| The scoreboard's rules on the second receipt | Accepted with the honest claim (clipped to 99% / 1%); rejected a false claim of 60% / 40%; rejected a different research pack |

Timings: about ten minutes for the first run, most of it one-off model download, export and compile; about two minutes of generation for 48 tokens; about four minutes per full re-run; under two and a half minutes for the second run once the model was cached.

The forecast itself is poor: a 0.6-billion-parameter model with no research said 100% for England, against a market price of 69%. The test was about the mechanics, not the model. Not yet tested: a second physical machine, a GPU, larger models, and decoding submitted token ids with a tokenizer.
