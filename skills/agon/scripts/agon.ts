/**
 * Shared setup for the Agon scripts. They are written to sit next to Gensyn's Delphi skill (the Agentic Trading
 * Toolkit): same .env, same wallet, same Delphi SDK. Nothing here imports from the Agon server, so the folder can
 * be copied into any project that has `@gensyn-ai/gensyn-delphi-sdk` and `viem` installed.
 *
 * Environment (the SDK loads `.env` by itself):
 *   WALLET_PRIVATE_KEY + DELPHI_SIGNER_TYPE=private_key, or the CDP variables   the toolkit's wallet
 *   DELPHI_NETWORK=mainnet                                                     Agon scores mainnet markets
 *   AGON_URL                                                                   default https://agon.nerom.site
 */
import { DelphiClient, type DelphiSigner } from "@gensyn-ai/gensyn-delphi-sdk";
import { keccak256, toHex } from "viem";

export const AGON = (process.env.AGON_URL ?? "https://agon.nerom.site").replace(/\/$/, "");
export const ZERO32 = ("0x" + "0".repeat(64)) as `0x${string}`;

async function call(path: string, init?: RequestInit) {
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(AGON + path, init);
      if (r.status >= 502 && r.status <= 504) { last = new Error(`Agon answered ${r.status}`); }
      else return { ok: r.ok, status: r.status, body: (await r.json()) as any };
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  throw last;
}
export const get = async (path: string) => {
  const r = await call(path);
  if (!r.ok) throw new Error(`${path}: ${r.body?.error ?? r.status}`);
  return r.body;
};
export const post = (path: string, body: unknown) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// The toolkit's client, configured from the environment exactly as the Delphi skill configures it.
const base = new DelphiClient();
let signer: DelphiSigner | null = null;
/** The wallet the Delphi skill trades with. Agon knows an agent by this address. */
export async function wallet(): Promise<DelphiSigner> {
  signer ??= await base.getSigner();
  return signer;
}

/** Agon's signing rules. Refuses to go on if the wallet is on a different chain from the scoreboard. */
export async function signing() {
  const s = await get("/league/v1/signing"), w = await wallet();
  const chain = await w.publicClient.getChainId();
  if (chain !== s.domain.chainId) throw new Error(`this wallet is on chain ${chain} but Agon scores chain ${s.domain.chainId}. Set DELPHI_NETWORK=mainnet.`);
  return s as { domain: any; types: any };
}

export interface AgonMarket { address: `0x${string}`; question: string; outcomes: string[]; probabilities: number[] | null; status: string; mechanism: string; gateway: `0x${string}`; factory: `0x${string}` }
export const market = (address: string) => get(`/v1/markets/${address}`) as Promise<AgonMarket>;

/**
 * A Delphi SDK client that works on this market. The SDK's defaults know two Delphi deployments; live trading also
 * runs through a gateway they do not name, and on those markets the default client fails. Agon's index knows which
 * gateway and factory own every market, so the client is pinned to those.
 */
export async function clientFor(m: AgonMarket): Promise<DelphiClient> {
  return new DelphiClient({ gatewayAddress: m.gateway, factoryAddress: m.factory });
}

/** Probabilities as Agon takes them: basis points per outcome, each between 100 and 9900, adding up to 10000. */
export function toBps(p: number[]): number[] {
  const sum = p.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) throw new Error("probabilities must be positive");
  const n = p.length, x = p.map((v) => Math.min(0.99, Math.max(0.01, v / sum)));
  for (let k = 0; k < 50; k++) {
    const s = x.reduce((a, b) => a + b, 0);
    if (Math.abs(s - 1) < 1e-9) break;
    for (let i = 0; i < n; i++) x[i] = Math.min(0.99, Math.max(0.01, x[i] / s));
  }
  const bps = x.map((v) => Math.round(v * 10000));
  let diff = 10000 - bps.reduce((a, b) => a + b, 0);
  for (let i = 0; diff !== 0 && i < 4 * n; i++) {
    const j = i % n, step = diff > 0 ? 1 : -1;
    if (bps[j] + step >= 100 && bps[j] + step <= 9900) { bps[j] += step; diff -= step; }
  }
  return bps;
}

export const hashText = (text: string) => keccak256(toHex(text));
export const pct = (p: number | null | undefined) => (p == null ? "–" : (p * 100).toFixed(1) + "%");
export const now = () => Math.floor(Date.now() / 1000);
export function fail(message: string): never { console.error(message); process.exit(1); }
