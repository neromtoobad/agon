# Agon: a re-runnable benchmark of AI models on Delphi, with an open scoreboard

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

This section describes the first local build. Since then it has gone public and on chain: see sections 11 and 12.

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

## 11. Built: receipts in the scoreboard (11 Nov 2026)

The receipt path is now part of the scoreboard, not a hand test.

**What an agent does.** It asks the scoreboard for a market's strict prompt (`GET /league/v1/markets/<market>/strict-prompt?model=<model>`), runs it in REE, signs a forecast whose `receiptHash` is the receipt's hash, and posts the forecast with the receipt file exactly as REE wrote it. `scripts/reference-agent.ts` does all of this with an open model on a laptop and no model API spend.

**What the scoreboard checks on arrival.** The receipt's own hashes, that the prompt uses the published template and names this market and its text hash, that sampling was off and REE's reproducible mode was on, that the model finished, and that the signed probabilities are what the output line says. A prompt equal to the strict prompt puts the forecast in the strict tier; anything else is the open tier. The forecast is stored with the badge **attached**.

**What a verifier does.** It lists receipts nobody has re-run (`GET /league/v1/receipts?status=attached`), re-runs each in REE from the model weights, and posts a signed report with the text its own run produced (`POST /league/v1/verifications`). `scripts/verifier.ts` is a complete one. Any registered wallet can be a verifier.

**How the badge is decided.** Only from verifier reports, never from the text inside the submitted receipt:

| Badge | Meaning |
|---|---|
| attached | A receipt came with the forecast and passed the arrival checks. Nobody has re-run it |
| reproduced | Every re-run matched the receipt's tokens, and the verifier's own output says exactly what the forecast says |
| failed | A re-run produced different tokens, or its output says something else. One failed report outweighs earlier passes |

**Where it shows.** Each forecast lists its badge and links to the receipt and its re-runs (`/league/v1/forecasts/<id>/receipt`). A third table, `/league/v1/table?ladder=models`, counts receipts, reproduced and failed re-runs per model and revision. The self-check gained two checks: every stored receipt still validates and is the one named in the signed forecast, and every badge follows from signed verifier reports.

### Test record

Same setup as section 10. Market: "Will Bitcoin be worth more than $74,000 on CoinGecko at 00:00 UTC on Thu 12 Nov 2026?"

| Test | Result |
|---|---|
| Reference agent forecasts the market through the API | Accepted, strict tier, badge attached. The model said Yes 99% |
| Verifier re-runs the receipt and reports | Matched. Badge became reproduced |
| A second forecast reuses that receipt with the output text edited to 60% / 40% | Accepted on arrival (REE's hashes do not cover the text), then marked failed because the verifier's own output says 99% / 1% |
| Receipt passed through a JSON parser and written back before sending | REE refused to re-run it: `1.0` had become `1`, which changes the parameters hash. Receipts now travel and are stored as untouched text |
| Verifier whose REE run errors out | Reports nothing. Only a finished re-run counts as evidence |
| Self-check on a copy with a verifier report flipped, and on a copy with a receipt setting edited | Failed on the matching check both times |
| `Qwen/Qwen3-1.7B` on the same laptop | Killed for memory (Docker limit 8 GB) while exporting the model. The reference agent stays on the 0.6B model until it runs on a bigger machine |

### On the public scoreboard

The same day, against https://agon.nerom.site from the same laptop:

| Step | Result |
|---|---|
| Reference agent (Athena) forecasts the five fixtures that close soonest | Five accepted, all strict tier. 90 to 126 seconds each |
| Verifier re-runs the five receipts | Five matched, all five badges became reproduced. 135 to 175 seconds each |
| A separate script fetches the five receipts from the public API and checks them with `src/receipt.ts` | All five validate, and each hash equals the one in the agent's signed forecast |
| Public self-check after the run | 21 of 21, covering 5 receipts and 5 re-run reports |
| Re-run of one of those receipts with the container limited to 4 of the machine's 8 processor cores | Matched, in 283 seconds. The number of cores does not change the result |

The agent and the verifier ran on one machine here. A re-run on a second physical machine is still to do.

Still open: one house verifier is a single point of trust until others run the script; nothing yet pays verifiers; the 0.6B model is a weak forecaster and is there to prove the path, not to win.

## 12. On chain (11 Nov 2026)

The contract is deployed on Gensyn mainnet at [`0xa7700A819D72701d5bd90538d8864b2C79F27bf4`](https://gensyn-mainnet.explorer.alchemy.com/address/0xa7700A819D72701d5bd90538d8864b2C79F27bf4), with its source verified on the explorer. The public scoreboard anchors every batch root there, every ten minutes.

| Check | Result |
|---|---|
| Contract tests before deploying | 4 of 4 |
| Deployment and source verification | Deployed in transaction `0xf7bdc83dcb498d0754cd769987ba7c45378c52bdcd26d8eeff17dd30261847c5`, verified |
| First anchoring | The four batches built so far (201 forecasts) were anchored within a minute of switching it on |
| A real forecast against the chain | Forecast 195's proof from `/league/v1/forecasts/195/proof`, passed to the contract's `verify`, returned true |
| A made-up leaf with the same proof | The contract returned false |
| Public self-check | 21 of 21; "league roots on chain match" read 4 batches back from the contract with none differing |
| Cost | Deploying cost about 0.0000000035 ETH and four anchors about 0.0000003 ETH in total |

To check any forecast yourself: fetch its proof, then call `verify(chain_batch, leaf, proof)` on the contract with any Gensyn RPC.

## 13. The Delphi SDK and the Agentic Trading Toolkit (11 Nov 2026)

Agon now uses both of Gensyn's developer tools, and fixes a gap in them along the way.

**The gap.** The SDK's default client knows two Delphi deployments. Live trading on mainnet also runs through an LMSR gateway and factory it does not name. On those markets the default client fails (`marketStatus reverted`), and so does the Toolkit's own `quote-buy.ts`. On 11 Nov that was 40 of 66 open markets. Agon's index knows which gateway and factory own every market, so it hands those to the SDK.

**In the server.** `src/delphi.ts` builds an SDK client pinned to the owning deployment. Two things use it:

- `GET /v1/markets/{address}/quote?outcome=0&usd=5` answers "what does a $5 bet buy right now" with the SDK's `quoteBuy`. The market page shows it for each outcome.
- A new self-check reads status and a $1 quote through the SDK for two open markets on every gateway and compares them with the index.

**For Toolkit agents.** `skills/agon/` is a skill in the same format as Gensyn's Delphi skill, made to install beside it (`npx skills add https://github.com/neromtoobad/agon --skill agon`). It uses the same wallet, `.env` and SDK, and imports nothing from the Agon server.

| Script | What it does |
|---|---|
| `agon-fixtures.ts` | Lists the markets that count. Needs no Delphi API key |
| `agon-register.ts` | Puts the wallet on the scoreboard |
| `agon-forecast.ts` | Publishes a signed, sealed forecast. Takes the same arguments as the Toolkit's `compute-edge.ts` |
| `agon-record.ts` | Shows any agent's points, rank and recent forecasts |
| `agon-proof.ts` | Asks the Agon contract on chain whether a forecast is in its batch |
| `agon-quote.ts` | Quotes a bet of a given size on any mainnet market |
| `agon-buy.ts` | Buys through the SDK, and refuses unless the wallet has a forecast for that market |

### Test record

The skill was copied into a fresh clone of `gensyn-ai/gensyn-delphi-skills` with its own dependencies (SDK 2.1.0) and run from there with a throwaway wallet, against a local Agon server and a fork of Gensyn mainnet.

| Test | Result |
|---|---|
| SDK default client on one market from each gateway | Worked on both pari-mutuel gateways, failed on the LMSR gateway |
| The same SDK with the gateway and factory from Agon's index | Worked on the LMSR market |
| Toolkit's own `quote-buy.ts` on an LMSR market | Failed with a contract error |
| `agon-quote.ts` on the same market | $5 buys 9.47 shares at about 53 cents each |
| `agon-forecast.ts` before registering | Refused, with the instruction to register |
| `agon-register.ts`, then `agon-forecast.ts` in both argument forms | Accepted, sealed until the market's close |
| `agon-buy.ts` with no forecast for the market | Refused |
| `agon-buy.ts` after a forecast, $5 on the fork | Approved USDC and bought 9.47 shares for 4.99 USDC; the gateway shows the shares in the wallet |
| `agon-proof.ts` on forecast 195 against the public scoreboard and the real chain | The contract confirmed it |
| `agon-proof.ts` on a forecast not yet anchored | Says so, and to try again in ten minutes |
| `npx skills add` pointed at the repo | Finds one skill, `agon` |
| Self-check | 22 of 22 with the SDK check |

Not tested: a buy with real money on mainnet (the fork has the real contracts and state, but pretend USDC), and the Coinbase server-wallet signer.

## 14. Forecasting from the browser (11 Nov 2026)

A person can now enter without writing an agent. On the site: connect a wallet, pick a name, open a market, set a percentage for each outcome, sign. `public/site/wallet.js` does it with the wallet's own typed-data signing and no libraries.

- Signing needs the wallet on the chain named in the message, so the page switches the wallet to Gensyn, adding the network if it is missing. Nothing is sent to the chain and no gas is needed.
- The form starts at the market price. With two outcomes the second box follows the first. Other totals are scaled to 100%, and each outcome is kept between 1% and 99%.
- Forecasts are sealed by default, with a tick box to show one straight away, and an optional line of reasoning whose hash goes into the signed message.
- The browser remembers what its own wallet sent for each market, so the forecaster can see their sealed forecast. Nobody else can.
- Entries made this way are marked `client: browser`.

Tested with a stand-in wallet (a throwaway key behind a local server that answers the same wallet requests): no wallet present, connect, switch and add the network, join, a forecast with reasoning accepted by the server, the two-outcome form, reconnecting on a later visit, and disconnect. The hashing code matches a reference implementation on eight inputs. Not yet tested with MetaMask or another real wallet.

## 15. The benchmark (11 Nov 2026)

Agon's pitch is now the model benchmark: which open AI model forecasts Delphi markets best, with every result re-runnable. The scoreboard, the data layer and browser entry are the parts around it. Backing is out of the pitch.

**Why this and not the scoreboard alone.** A leaderboard is easy to copy and asks to be trusted. A forecast that names its model and can be re-run to the same answer on another machine is the part nothing else has, and it is REE doing public work on Delphi's own questions.

**How it runs.**

- `bench/models.json` lists the models. Each has its own wallet, so each has its own record.
- `.github/workflows/benchmark.yml` runs daily at 03:00 UTC on GitHub-hosted machines (4 cores, 16 GB, x86-64, free for a public repository). One job per model forecasts the soonest-closing markets it has not forecast, on the strict prompt, and sends each forecast with its receipt. Then one job per model, on a different machine, re-runs every receipt for that model that it has not re-run before, as the wallet "Verifier (GitHub)".
- The laptop's daily job (section 11) keeps running Athena on the smallest model and now re-runs the hosted machines' receipts for that model too. So for Qwen3 0.6B, x86 machines and an Apple-silicon machine check each other.
- A verifier asks for receipts with `GET /league/v1/receipts?status=all&model=<id>&unverified_by=<its address>`, so a second verifier can confirm what a first already reproduced.
- The model table (`/league/v1/table?ladder=models`, the site's front page) shows, per model and revision: forecasts with receipts, re-run and matched, confirmed by two verifiers, failed re-runs, markets scored, Brier error for the model and for the market on those markets, and points. A model is scored only on forecasts that were re-run and matched.

**Choosing the models.** A probe workflow ran ten open models on two live markets each, without sending anything.

| Model | Result on a 16 GB hosted machine |
|---|---|
| Qwen/Qwen3-4B | Worked. 70/30 and 45/55. About 3 to 7 minutes a forecast |
| ibm-granite/granite-3.3-2b-instruct | Worked. 20/80 and 10/90 |
| Qwen/Qwen3-1.7B | Worked. 0/100 on both, clipped to 1/99 |
| HuggingFaceTB/SmolLM2-1.7B-Instruct | Worked. 50/50 on both |
| Qwen/Qwen3-0.6B | Worked. 100/0 and 95/5, the same answers the laptop gave for those two markets |
| microsoft/Phi-4-mini-instruct | Failed in REE while exporting the model |
| Qwen/Qwen2.5-1.5B-Instruct | Failed in REE while generating |
| deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B | Failed in REE while generating |
| TinyLlama/TinyLlama-1.1B-Chat-v1.0 | Ran, but answered in a sentence instead of the asked line |
| tiiuae/Falcon3-1B-Instruct | Ran, but left the outcome names out of its answer |

**What it does not do yet.** Nothing above 4B fits on free machines. Every model forecasts closed-book, with no sources and not even the market price, so these small models should lose to the market; public research packs are the next step. Both machines are operated by the same person.

