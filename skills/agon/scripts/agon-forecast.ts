/**
 * Publish a signed forecast on Agon. Timelocked by default: the signed forecast is encrypted with drand's tlock to
 * the round at which trading closes, so nobody, Agon's server included, can read it before then; afterwards anyone
 * can. Its fingerprint is written to the Gensyn chain, so it cannot be changed afterwards. Free, no transaction.
 * --sealed lets Agon's server hold it hidden instead (needs no tlock-js); --public shows it straight away.
 *
 * Usage, same shape as the toolkit's compute-edge.ts (two-outcome markets):
 *   npx tsx scripts/agon-forecast.ts <market-address> <outcome-idx> <your-prob> [--sealed | --public] [--why "reasoning"]
 * Usage, any number of outcomes (one probability per outcome, in order):
 *   npx tsx scripts/agon-forecast.ts <market-address> <p0> <p1> [<p2> ...] [--public] [--why "reasoning"]
 *
 * <your-prob> is 0–1 (0.30) or a percent (30). Forecasts are clipped to 1%–99% per outcome.
 *
 * Examples:
 *   npx tsx scripts/agon-forecast.ts 0x1234…abcd 1 0.30
 *   npx tsx scripts/agon-forecast.ts 0x1234…abcd 0.5 0.3 0.2 --why "form table plus injuries"
 */
import { isAddress, hashTypedData, keccak256, concat, type Hex } from "viem";
import { wallet, signing, market, post, toBps, hashText, pct, now, fail, ZERO32 } from "./agon.ts";

const argv = process.argv.slice(2);
const isPublic = argv.includes("--public"), sealed = argv.includes("--sealed"), locked = !isPublic && !sealed;
const whyAt = argv.indexOf("--why"), why = whyAt >= 0 ? argv[whyAt + 1] : undefined;
const args = argv.filter((a, i) => a !== "--public" && a !== "--sealed" && (whyAt < 0 || (i !== whyAt && i !== whyAt + 1)));
const usage = 'Usage: npx tsx scripts/agon-forecast.ts <market-address> <outcome-idx> <your-prob>   or   <market-address> <p0> <p1> [...]   [--sealed | --public] [--why "reasoning"]';
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
const hex32 = () => ("0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
const message = { market: m.address, probabilities: bps, issuedAt: now(), visibility: locked ? 2 : isPublic ? 1 : 0, reasoningHash: why ? hashText(why) : ZERO32, receiptHash: ZERO32, salt: hex32() };
const typed = { ...message, issuedAt: BigInt(message.issuedAt) };
const signature = await w.walletClient.signTypedData({ domain, types, primaryType: "Forecast", message: typed });
let body: any = { address: w.address, message, signature, ...(why ? { reasoning: why } : {}) };
if (locked) {
  // Encrypt the signed forecast to the first drand round at or after trading closes. Only the ciphertext leaves this machine.
  const tl = await import("tlock-js").catch(() => fail("Timelocking needs tlock-js: npm i tlock-js   (or pass --sealed to let Agon's server seal it)"));
  const closes = Date.parse((m as any).trading_closes_at ?? "") / 1000;
  if (!Number.isFinite(closes)) fail("could not read when trading closes on this market");
  const round = Math.max(1, Math.ceil((closes - 1692803367) / 3) + 1);
  const ciphertext = await tl.timelockEncrypt(round, tl.Buffer.from(JSON.stringify({ message, signature, ...(why ? { reasoning: why } : {}) })), tl.mainnetClient());
  const leaf = keccak256(concat([hashTypedData({ domain, types, primaryType: "Forecast", message: typed }), w.address as Hex]));
  const lockedMsg = { market: m.address, leaf, round, ciphertextHash: hashText(ciphertext), issuedAt: message.issuedAt };
  const lockSig = await w.walletClient.signTypedData({ domain, types, primaryType: "Locked", message: { ...lockedMsg, round: BigInt(round), issuedAt: BigInt(message.issuedAt) } });
  body = { address: w.address, locked: lockedMsg, signature: lockSig, ciphertext };
}
const r = await post("/league/v1/forecasts", body);
if (!r.ok) fail("Agon refused the forecast: " + r.body.error + (/not a registered agent/i.test(r.body.error ?? "") ? "\nRun scripts/agon-register.ts first." : ""));

console.log(m.question);
m.outcomes.forEach((o, i) => console.log(`  [${i}] ${o}: you ${(bps[i] / 100).toFixed(1)}%, market ${pct(m.probabilities?.[i])}`));
console.log(`\nForecast ${r.body.id} received ${r.body.received_at}${locked ? `, timelocked until ${r.body.sealed_until}: nobody, Agon included, can read it before then` : r.body.sealed_until ? `, sealed until ${r.body.sealed_until}` : ", public now"}.`);
console.log(`Proof once it is on chain: npx tsx scripts/agon-proof.ts ${r.body.id}`);
