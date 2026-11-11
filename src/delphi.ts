// The Delphi SDK, pointed at the right contracts.
//
// The SDK's own defaults know two Delphi deployments. Live trading on mainnet also runs through an LMSR gateway and
// factory it does not name, and on those markets it fails. Agon's index knows which gateway and factory own every
// market, so it hands those to the SDK and the SDK's quotes, status reads and trades work everywhere.

import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { generatePrivateKey } from "viem/accounts";
import { db } from "./db.ts";
import { network, lc } from "./config.ts";

export const SDK_NAME = "@gensyn-ai/gensyn-delphi-sdk";

/** Which gateway and factory own a market, from the index. */
export function deployment(market: string): { gateway: `0x${string}`; factory: `0x${string}`; mechanism: string } | null {
  const m = db.prepare("SELECT gateway, factory, mechanism FROM markets WHERE address = ?").get(lc(market)) as any;
  return m?.gateway ? { gateway: m.gateway, factory: m.factory, mechanism: m.mechanism } : null;
}

// The SDK wants a signer even to read. This key is made fresh at start, never funded and never used to send anything.
const readKey = generatePrivateKey();
const clients = new Map<string, DelphiClient>();

/** An SDK client pinned to the deployment that owns this market. */
export function sdkFor(market: string): DelphiClient | null {
  const d = deployment(market);
  if (!d) return null;
  let c = clients.get(d.gateway);
  if (!c) {
    c = new DelphiClient({
      network: network.name === "mainnet" ? "mainnet" : "testnet", signerType: "private_key", privateKey: readKey,
      rpcUrl: network.rpcUrl, chainId: network.chainId, gatewayAddress: d.gateway, factoryAddress: d.factory,
      tokenAddress: network.collateral.address as `0x${string}`,
    });
    clients.set(d.gateway, c);
  }
  return c;
}

const SHARE = 10n ** 18n, UNIT = 10 ** network.collateral.decimals;
const cache = new Map<string, { at: number; value: any }>();

/**
 * What a bet of `usd` on one outcome buys right now, quoted by the SDK. The gateway quotes cost for an exact number
 * of shares, so this walks toward the budget: guess from the current price, quote, and close in, at most eight times.
 */
export async function quoteBudget(market: string, outcomeIdx: number, usd: number) {
  const key = `${lc(market)}:${outcomeIdx}:${usd}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const client = sdkFor(market), d = deployment(market);
  if (!client || !d) return null;
  const row = db.prepare("SELECT probs, outcomes, status FROM markets WHERE address = ?").get(lc(market)) as any;
  const probs: number[] = row?.probs ? JSON.parse(row.probs) : [], outcomes: string[] = row?.outcomes ? JSON.parse(row.outcomes) : [];
  const p = probs[outcomeIdx] > 0 ? probs[outcomeIdx] : 1 / Math.max(2, outcomes.length);
  // Cost grows faster than shares on a thin market, so keep the closest quote under and over the budget and aim between them.
  const quote = async (n: number) => {
    const sharesOut = BigInt(Math.max(1, Math.round(n * 1e6))) * (SHARE / 1_000_000n);
    const { tokensIn } = await client.quoteBuy({ marketAddress: market as `0x${string}`, outcomeIdx, sharesOut });
    return Number(tokensIn) / UNIT;
  };
  let lo: [number, number] | null = null, hi: [number, number] | null = null, guess = usd / p, calls = 0;
  while (calls < 8) {
    const c = await quote(guess);
    calls++;
    if (c <= usd) { if (!lo || guess > lo[0]) lo = [guess, c]; } else if (!hi || guess < hi[0]) hi = [guess, c];
    if (c > 0 && Math.abs(c - usd) / usd < 0.005) break;
    if (lo && hi) guess = lo[0] + ((hi[0] - lo[0]) * (usd - lo[1])) / (hi[1] - lo[1]);
    else guess *= c > 0 ? Math.max(0.25, Math.min(4, usd / c)) : 2;
    if (lo && hi && (hi[0] - lo[0]) / hi[0] < 0.002) break;
  }
  // Report the most shares that fit inside the budget; only if nothing fits, the cheapest quote seen.
  const [shares, cost] = lo ?? hi ?? [0, 0];
  const value = {
    market: lc(market), outcome: outcomeIdx, outcome_label: outcomes[outcomeIdx] ?? null, budget_usd: usd,
    shares: Math.round(shares * 1e4) / 1e4, cost_usd: Math.round(cost * 1e6) / 1e6,
    average_price: shares > 0 ? Math.round((cost / shares) * 1e4) / 1e4 : null,
    probability_now: probs[outcomeIdx] ?? null,
    mechanism: d.mechanism, gateway: d.gateway, quoted_by: SDK_NAME, sdk_calls: calls, at: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 2000) for (const [k, v] of cache) if (Date.now() - v.at > 30_000) cache.delete(k);
  return value;
}

/** The market's lifecycle status as the SDK reads it from the owning gateway. */
export async function sdkStatus(market: string): Promise<string | null> {
  const client = sdkFor(market);
  return client ? await client.getMarketStatus(market as `0x${string}`) : null;
}
