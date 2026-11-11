import { createPublicClient, http, defineChain, parseAbi } from "viem";
import { db, tx } from "./db.ts";
import { network, lc } from "./config.ts";
import { explorerContract } from "./sources/logs.ts";

const chain = defineChain({
  id: network.chainId, name: `Gensyn ${network.name}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [network.rpcUrl] } }, contracts: { multicall3: { address: network.multicall3 } },
});
export const client = createPublicClient({ chain, transport: http(network.rpcUrl, { timeout: 45000, retryCount: 3 }), batch: { multicall: { batchSize: 4096, wait: 20 } } });

export const GATEWAY_ABI = parseAbi([
  "function delphiFactory() view returns (address)",
  "function marketStatus(address marketProxy) view returns (uint8)",
  "function marketCreatorSharesPerOutcome(address marketProxy) view returns (uint256)",
  "function spotImpliedProbabilities(address marketProxy, uint256[] outcomeIndices) view returns (uint256[])",
  "function totalSupplies(address marketProxy, uint256[] outcomeIndices) view returns (uint256[])",
]);
const DPM_ABI = parseAbi([
  "function getMarket(address marketProxy) view returns (((uint256 outcomeCount, uint256 k, uint256 tradingFee, uint256 tradingDeadline, uint256 settlementDeadline) config, uint256 initialPool, uint256 pool, uint256 tradingFees, uint256 refund, uint256 sumTerm36, uint256 winningOutcomeIdx))",
]);

export const STATUS = ["open", "awaiting_settlement", "settled", "expired", "failed"] as const;

/** Pair every gateway with its factory, tag which contracts an official source names, and attach each market to its gateway. */
export async function syncRegistry(log?: (s: string) => void) {
  const listed = new Map<string, string>();
  for (const a of [...network.listed.sdk.gateways, ...network.listed.sdk.factories]) listed.set(lc(a), network.listed.sdk.source);
  const rows = db.prepare("SELECT address, role, factory, explorer_name FROM contracts").all() as any[];
  for (const c of rows) {
    if (c.role === "gateway" && !c.factory) {
      try {
        const f = lc(await client.readContract({ address: c.address, abi: GATEWAY_ABI, functionName: "delphiFactory" }));
        db.prepare("UPDATE contracts SET factory=? WHERE address=?").run(f, c.address);
      } catch { log?.(`  ${c.address} emits gateway events but has no delphiFactory(); left unpaired`); }
    }
    if (!c.explorer_name) {
      const e = await explorerContract(c.address);
      if (e.name) db.prepare("UPDATE contracts SET explorer_name=?, verified=? WHERE address=?").run(e.name, e.verified ? 1 : 0, c.address);
    }
    db.prepare("UPDATE contracts SET listed=?, listed_source=? WHERE address=?").run(listed.has(c.address) ? 1 : 0, listed.get(c.address) ?? null, c.address);
  }
  db.exec(`UPDATE markets SET gateway=(SELECT g.address FROM contracts g WHERE g.role='gateway' AND g.factory=markets.factory) WHERE gateway IS NULL`);
}

/** Pari-mutuel factories do not put the market's rules in the creation event, so read them from the gateway once. */
export async function syncDpmConfig(log?: (s: string) => void) {
  const rows = db.prepare("SELECT address, gateway FROM markets WHERE mechanism='dpm' AND gateway IS NOT NULL AND trading_deadline IS NULL").all() as any[];
  if (!rows.length) return;
  const up = db.prepare("UPDATE markets SET outcome_count=?, liquidity_param=?, trading_fee=?, trading_deadline=?, settlement_deadline=?, init_shares=? WHERE address=?");
  for (let i = 0; i < rows.length; i += 150) {
    const part = rows.slice(i, i + 150);
    const res = await client.multicall({
      allowFailure: true,
      contracts: part.flatMap((m) => [
        { address: m.gateway, abi: DPM_ABI, functionName: "getMarket", args: [m.address] },
        { address: m.gateway, abi: GATEWAY_ABI, functionName: "marketCreatorSharesPerOutcome", args: [m.address] },
      ]) as any,
    });
    tx(() => part.forEach((m, j) => {
      const g = res[2 * j], s = res[2 * j + 1];
      if (g.status !== "success") return;
      const c = (g.result as any).config;
      up.run(Number(c.outcomeCount), String(c.k), Number(c.tradingFee) / 1e18, Number(c.tradingDeadline), Number(c.settlementDeadline), s.status === "success" ? String(s.result) : null, m.address);
    }));
    log?.(`  pari-mutuel rules read: ${Math.min(i + 150, rows.length)}/${rows.length}`);
  }
}

/** Current on-chain probabilities and status for a set of markets. Used by `verify` to check the derived numbers. */
export async function readLive(markets: { address: string; gateway: string; outcome_count: number }[]) {
  const res = await client.multicall({
    allowFailure: true,
    contracts: markets.flatMap((m) => [
      { address: m.gateway, abi: GATEWAY_ABI, functionName: "spotImpliedProbabilities", args: [m.address, Array.from({ length: m.outcome_count }, (_, i) => BigInt(i))] },
      { address: m.gateway, abi: GATEWAY_ABI, functionName: "marketStatus", args: [m.address] },
    ]) as any,
  });
  return markets.map((m, j) => ({
    address: m.address,
    probs: res[2 * j].status === "success" ? (res[2 * j].result as bigint[]).map((p) => Number(p) / 1e18) : null,
    status: res[2 * j + 1].status === "success" ? STATUS[Number(res[2 * j + 1].result)] : null,
  }));
}
