# Backing: let a proven agent bet for you, inside limits the chain enforces

Design draft, 11 Nov 2026. This is the layer for people, on top of the scoreboard in [AGON.md](AGON.md). It takes its shape from CROSSFIRE (follow or fade an agent under a chain-capped mandate, revoke in one tap) and applies it to Delphi. The contract exists and is tested on a fork; nothing else here is built.

## 1. What a person can do

| Mode | What happens | Who signs each bet |
|---|---|---|
| **Suggest** | The assistant shows a bet with the case for and against, the agent's record, and the price. You place it with one tap | You |
| **Back** | You pick an agent from the scoreboard and set a budget. When the agent bets its own money, it places the same bet for you, scaled to your limits | The agent, inside your limits |
| **Fade** | Same as Back, on the opposite outcome | The agent, inside your limits |

Every bet lands in your own wallet as ordinary Delphi shares. You see it on Delphi and redeem it there.

## 2. Setup in three steps

1. **Connect a wallet.** The page adds the Gensyn network for you.
2. **Have USDC on Gensyn.** The page shows your balance and links to a bridge if it is empty.
3. **Set your limits and approve.** Most per bet, most per day, most in total, and an end date. One approval and one grant.

To stop: press Revoke, or set the approval to zero from any wallet. Either works immediately.

## 3. How the mandate works

A small contract, `Mandate`, with no owner, no fee and no upgrade path ([source](../contracts/src/Mandate.sol)).

- **It never holds your money.** A bet pulls USDC from your wallet, buys on Delphi and sends the shares to your wallet, all in one transaction. Between bets the contract's balance is zero.
- **Three independent limits.** The mandate's caps (per bet, per day, total), its end date, and the USDC allowance you gave the contract.
- **You choose the gateway.** The mandate names the Delphi gateway the agent may trade through, so nobody can point your money at another contract later.
- **The agent never touches the money.** It can only call `bet`, and only for people who granted it a mandate.

This works because of how Delphi's live contracts are written (read from their verified source): the gateway mints shares to whoever calls it, and shares are transferable to any address except the market itself.

### Tested against the live contracts

Seven tests on a fork of Gensyn mainnet, against the live LMSR gateway and the open England v Croatia market. All pass.

| Test | Result |
|---|---|
| Agent bets inside the limits | Cost $1.435730, exactly Delphi's quote. Shares in the person's wallet; contract holds no money and no shares; agent's balance untouched |
| Bet over the per-bet cap | Reverts |
| Bets past the daily cap | Reverts, then allowed again the next day |
| A wallet with no mandate tries to bet | Reverts |
| After Revoke | Reverts |
| After the person sets the allowance to zero | Reverts |
| After the end date | Reverts |

Run them: `cd contracts && GENSYN_RPC_URL=https://gensyn-mainnet.g.alchemy.com/public forge test -vv`

Not done: deployment to mainnet, an independent review of the contract, and the pari-mutuel gateways (only the live LMSR gateway is tested).

## 4. Which agents can be backed

- Only agents on the scoreboard with a ranked record, that opt in.
- **Skin in the game.** An agent may only place a bet for backers that it has already placed with its own wallet, on the same market and outcome. Tripod sees both, so a mirrored bet with no matching own bet is flagged publicly.
- Sizing is proportional: if the agent staked 2% of its bankroll, each backer stakes 2% of their total limit, never more than their per-bet cap.
- The starter kit ships the mirroring step, and the reference agent offers it from day one.

## 5. The pages

| Page | What it shows |
|---|---|
| **Agents** | The table, with a Back button on agents that accept backers |
| **Agent** | Record, calibration, every past call with its outcome, current backers and their combined limits |
| **Call** | One bet: the case for and against in the Delphi Duel format, the price, and Back or Fade |
| **Your bets** | Positions, mandates with their remaining limits, and Revoke |
| **Proof** | The contract, the test results, and on-chain links for each claim |

### Built so far

A preview of all six pages is served at `/` (source in `public/site/`), in the halftone print direction. Market data, the traders table and the Proof page are live. Agents, their records and mandates are sample data and are labelled so; "Approve and start" saves a mandate in the browser only. Wallets are switched off.

## 6. Limits to be honest about

- **Delphi's markets are shallow.** Most have $10 to $50 of depth. A $3 bet in a $10-deep market moves the price by about ten points, so each extra backer pays a worse price than the last. Until markets deepen, backing only works with a few dollars per bet and a few backers per agent. Planned guard: a "never pay more than" price ceiling in the mandate.
- **An agent could profit at its backers' expense** by buying first, letting backers' bets push the price up, then selling. Small caps limit the damage; Tripod flags an agent that sells soon after a mirrored buy. This is policed in public, not prevented by the contract.
- **Allowance exposure.** The contract holds nothing, but a bug could expose up to the amount a person approved. Keep approvals small until the contract has been reviewed.
- **Regions.** Delphi does not allow trading from some countries. The pages must apply the same list.
- **Gas.** Each step needs a little ETH on Gensyn, though fees are a fraction of a cent. A signature-based, gas-free setup is possible later.
- **Scope.** This is a second product on top of the scoreboard. In the grant it belongs as a prototyped next phase, not a promise inside the six weeks.
