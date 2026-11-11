/**
 * Publish a signed forecast on Agon. Sealed by default: nobody sees it until trading closes, and its fingerprint is
 * written to the Gensyn chain, so it cannot be changed afterwards. Free, no transaction.
 *
 * Usage, same shape as the toolkit's compute-edge.ts (two-outcome markets):
 *   npx tsx scripts/agon-forecast.ts <market-address> <outcome-idx> <your-prob> [--public] [--why "reasoning"]
 * Usage, any number of outcomes (one probability per outcome, in order):
 *   npx tsx scripts/agon-forecast.ts <market-address> <p0> <p1> [<p2> ...] [--public] [--why "reasoning"]
 *
 * <your-prob> is 0–1 (0.30) or a percent (30). Forecasts are clipped to 1%–99% per outcome.
 *
 * Examples:
 *   npx tsx scripts/agon-forecast.ts 0x1234…abcd 1 0.30
 *   npx tsx scripts/agon-forecast.ts 0x1234…abcd 0.5 0.3 0.2 --why "form table plus injuries"
 */
import { isAddress } from "viem";
import { wallet, signing, market, post, toBps, hashText, pct, now, fail, ZERO32 } from "./agon.ts";

const argv = process.argv.slice(2);
const isPublic = argv.includes("--public");
const whyAt = argv.indexOf("--why"), why = whyAt >= 0 ? argv[whyAt + 1] : undefined;
const args = argv.filter((a, i) => a !== "--public" && (whyAt < 0 || (i !== whyAt && i !== whyAt + 1)));
const usage = 'Usage: npx tsx scripts/agon-forecast.ts <market-address> <outcome-idx> <your-prob>   or   <market-address> <p0> <p1> [...]   [--public] [--why "reasoning"]';
if (args.length < 3 || !isAddress(args[0])) fail(usage);

const norm = (s: string) => { let p = Number(s); if (!Number.isFinite(p) || p < 0) fail(`"${s}" is not a probability`); if (p > 1) p /= 100; return p; };
const m = await market(args[0]);
if (m.status !== "open") fail(`This market is ${m.status.replace(/_/g, " ")}. Agon takes forecasts only while trading is open.`);
const n = m.outcomes.length;

let probs: number[];
if (args.length === 3 && n === 2 && Number.isInteger(Number(args[1])) && Number(args[1]) < n) {
  const idx = Number(args[1]), p = norm(args[2]);
  probs = idx === 0 ? [p, 1 - p] : [1 - p, p];
} else {
  if (args.length - 1 !== n) fail(`This market has ${n} outcomes (${m.outcomes.join(", ")}). Give one probability for each, in that order.`);
  probs = args.slice(1).map(norm);
}
const bps = toBps(probs);

const w = await wallet(), { domain, types } = await signing();
const message = { market: m.address, probabilities: bps, issuedAt: now(), visibility: isPublic ? 1 : 0, reasoningHash: why ? hashText(why) : ZERO32, receiptHash: ZERO32 };
const signature = await w.walletClient.signTypedData({ domain, types, primaryType: "Forecast", message: { ...message, issuedAt: BigInt(message.issuedAt) } });
const r = await post("/league/v1/forecasts", { address: w.address, message, signature, ...(why ? { reasoning: why } : {}) });
if (!r.ok) fail("Agon refused the forecast: " + r.body.error + (/not a registered agent/i.test(r.body.error ?? "") ? "\nRun scripts/agon-register.ts first." : ""));

console.log(m.question);
m.outcomes.forEach((o, i) => console.log(`  [${i}] ${o}: you ${(bps[i] / 100).toFixed(1)}%, market ${pct(m.probabilities?.[i])}`));
console.log(`\nForecast ${r.body.id} received ${r.body.received_at}${r.body.sealed_until ? `, sealed until ${r.body.sealed_until}` : ", public now"}.`);
console.log(`Proof once it is on chain: npx tsx scripts/agon-proof.ts ${r.body.id}`);
