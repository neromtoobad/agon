/**
 * Forecast first, then trade. Buys shares through the Delphi SDK, pinned to the gateway that owns the market, but
 * only after this wallet has a signed forecast for the market on Agon. That way the bet has a public, timestamped
 * reason behind it, and the wallet builds a record others can check.
 *
 * Before buying, the wallet also calls commit(leaf) on the Agon contract with that forecast's fingerprint, so the
 * chain itself shows the forecast came before the trade (a little gas). --no-commit skips that.
 *
 * Usage: npx tsx scripts/agon-buy.ts <market-address> <outcome-idx> <usd> [slippage-pct] [--no-forecast] [--no-commit]
 *
 * Example:
 *   npx tsx scripts/agon-forecast.ts 0x1234…abcd 0 0.72
 *   npx tsx scripts/agon-buy.ts      0x1234…abcd 0 5
 */
import { isAddress, parseAbi } from "viem";
import { market, clientFor, wallet, get, post, fail } from "./agon.ts";

const AGON_CONTRACT = "0xa7700A819D72701d5bd90538d8864b2C79F27bf4";
const argv = process.argv.slice(2), skip = argv.includes("--no-forecast"), noCommit = argv.includes("--no-commit");
const args = argv.filter((a) => a !== "--no-forecast" && a !== "--no-commit");
const [addr, idxStr, usdStr, slipStr = "2"] = args;
if (!addr || !isAddress(addr) || idxStr == null || !usdStr) fail("Usage: npx tsx scripts/agon-buy.ts <market-address> <outcome-idx> <usd> [slippage-pct] [--no-forecast]");
const outcomeIdx = Number(idxStr), usd = Number(usdStr), slippageBps = BigInt(Math.round(Number(slipStr) * 100));

const m = await market(addr), w = await wallet();
if (m.status !== "open") fail(`This market is ${m.status.replace(/_/g, " ")}; it cannot be traded.`);
let latest: any = null;
if (!skip) {
  const me = await get(`/league/v1/agents/${w.address.toLowerCase()}?limit=500`).catch(() => null);
  latest = me?.forecasts?.find((f: any) => f.market === m.address.toLowerCase()); // newest first
  if (!latest)
    fail(`This wallet has no forecast for this market on Agon.\nPublish one first:  npx tsx scripts/agon-forecast.ts ${m.address} ${outcomeIdx} <your-prob>\n(or pass --no-forecast to trade without one)`);
}

const client = await clientFor(m);
// Find the most shares the budget buys, quoting through the SDK.
const p = m.probabilities?.[outcomeIdx] || 1 / m.outcomes.length;
const units = (n: number) => BigInt(Math.max(1, Math.round(n * 1e6))) * 10n ** 12n;
let lo: [number, bigint] | null = null, hi: number | null = null, guess = usd / p;
for (let k = 0; k < 8; k++) {
  const { tokensIn } = await client.quoteBuy({ marketAddress: m.address, outcomeIdx, sharesOut: units(guess) });
  const c = Number(tokensIn) / 1e6;
  if (c <= usd) { if (!lo || guess > Number(lo[0])) lo = [guess, tokensIn]; } else if (hi == null || guess < hi) hi = guess;
  if (c > 0 && c <= usd && (usd - c) / usd < 0.01) break;
  guess = lo && hi != null ? (lo[0] + hi) / 2 : guess * (c > 0 ? Math.max(0.25, Math.min(4, usd / c)) : 2);
}
if (!lo) fail(`Even the smallest amount costs more than $${usd} on this market.`);
const sharesOut = units(lo[0]), maxTokensIn = (lo[1] * (10000n + slippageBps)) / 10000n;

console.log(m.question);
console.log(`  buying ${lo[0].toFixed(4)} shares of [${outcomeIdx}] ${m.outcomes[outcomeIdx]} for about ${(Number(lo[1]) / 1e6).toFixed(6)} USDC (limit ${(Number(maxTokensIn) / 1e6).toFixed(6)})`);
if (latest && !noCommit && !latest.commit) {
  // The forecast's fingerprint goes on chain from this wallet, in a block before the buy.
  const hash = await w.walletClient.writeContract({ address: AGON_CONTRACT, abi: parseAbi(["function commit(bytes32 leaf)"]), functionName: "commit", args: [latest.leaf], account: w.walletClient.account!, chain: w.walletClient.chain });
  const rc = await w.publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") fail(`the commit transaction reverted: ${hash}`);
  console.log(`  committed forecast ${latest.id} on chain: ${hash}`);
  await post(`/league/v1/forecasts/${latest.id}/commit`, { tx: hash }).catch(() => null); // Agon's scanner finds it anyway
}
const approval = await client.ensureTokenApproval({ marketAddress: m.address, minimumAmount: maxTokensIn });
if (approval.approvalNeeded) console.log(`  approved USDC: ${approval.transactionHash}`);
const { transactionHash } = await client.buyShares({ marketAddress: m.address, outcomeIdx, sharesOut, maxTokensIn });
console.log(`  bought: ${transactionHash}`);
console.log(`  wallet: ${w.address}`);
