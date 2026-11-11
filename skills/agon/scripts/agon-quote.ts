/**
 * What a bet of a given size buys right now (read-only, no gas). Works on every Delphi market on mainnet, including
 * the ones the SDK's default client cannot reach, because Agon tells the SDK which gateway owns the market.
 * Usage: npx tsx scripts/agon-quote.ts <market-address> <outcome-idx> <usd>
 */
import { isAddress } from "viem";
import { market, clientFor, pct, fail } from "./agon.ts";

const [, , addr, idxStr, usdStr] = process.argv;
if (!addr || !isAddress(addr) || idxStr == null || !usdStr) fail("Usage: npx tsx scripts/agon-quote.ts <market-address> <outcome-idx> <usd>");
const outcomeIdx = Number(idxStr), usd = Number(usdStr);

const m = await market(addr), client = await clientFor(m);
async function sharesFor(budget: number) {
  const p = m.probabilities?.[outcomeIdx] || 1 / m.outcomes.length;
  const quote = async (n: number) => Number((await client.quoteBuy({ marketAddress: m.address, outcomeIdx, sharesOut: BigInt(Math.max(1, Math.round(n * 1e6))) * 10n ** 12n })).tokensIn) / 1e6;
  let lo: [number, number] | null = null, hi: [number, number] | null = null, guess = budget / p;
  for (let k = 0; k < 8; k++) {
    const c = await quote(guess);
    if (c <= budget) { if (!lo || guess > lo[0]) lo = [guess, c]; } else if (!hi || guess < hi[0]) hi = [guess, c];
    if (c > 0 && Math.abs(c - budget) / budget < 0.005) break;
    if (lo && hi) guess = lo[0] + ((hi[0] - lo[0]) * (budget - lo[1])) / (hi[1] - lo[1]);
    else guess *= c > 0 ? Math.max(0.25, Math.min(4, budget / c)) : 2;
  }
  return lo ?? hi ?? [0, 0];
}
const [shares, cost] = await sharesFor(usd);
console.log(m.question);
console.log(`  outcome:        [${outcomeIdx}] ${m.outcomes[outcomeIdx]}`);
console.log(`  market price:   ${pct(m.probabilities?.[outcomeIdx])}`);
console.log(`  $${usd} buys:      ${shares.toFixed(4)} shares for ${cost.toFixed(6)} USDC`);
console.log(`  average price:  ${(cost / shares).toFixed(4)} USDC a share`);
console.log(`  gateway:        ${m.gateway} (${m.mechanism === "lmsr" ? "LMSR" : "pari-mutuel"})`);
