import { db, tx, getCursor, setCursor } from "./db.ts";
import { network, UA } from "./config.ts";
import { EVENT_DEFS, DEF_BY_TOPIC, type RawLog } from "./events.ts";
import { rpc, headBlock } from "./sources/logs.ts";
import { store, type NewEvent } from "./ingest.ts";

/**
 * The block explorer's log index has holes: it can know a transaction and still hold none of its logs.
 * The node is the ground truth, so both functions below read from the node and insert whatever the
 * explorer-based backfill missed.
 */

const tsCache = new Map<number, number>();
async function blockTs(n: number) {
  let t = tsCache.get(n);
  if (t === undefined) { t = Number((await rpc<any>("eth_getBlockByNumber", ["0x" + n.toString(16), false])).timestamp); tsCache.set(n, t); }
  return t;
}
async function toRaw(l: any): Promise<RawLog> {
  const b = Number(l.blockNumber);
  return { address: String(l.address).toLowerCase(), topics: l.topics, data: l.data, blockNumber: b, logIndex: Number(l.logIndex), transactionHash: l.transactionHash, timestamp: l.blockTimestamp ? Number(l.blockTimestamp) : await blockTs(b) };
}

/** Re-read specific transactions from the node and store any Delphi logs in them. */
export async function repairTxs(hashes: string[]): Promise<NewEvent[]> {
  const fresh: NewEvent[] = [];
  for (const h of hashes) {
    const r = await rpc<any>("eth_getTransactionReceipt", [h]);
    if (!r) continue;
    const raws: RawLog[] = [];
    for (const l of r.logs) if (DEF_BY_TOPIC.has(l.topics[0])) raws.push(await toRaw(l));
    tx(() => { for (const l of raws) { const e = store(l); if (e) fresh.push(e); } });
  }
  return fresh;
}

const SUBGRAPHS: { gateway: string; url: string; colls: string[] }[] = [
  { gateway: "0x4e4e85c52e0f414cc67ee88d0c649ec81698d700", url: "https://api.goldsky.com/api/public/project_cmnoqdag1obop01z3efnu8ssq/subgraphs/delphi-mainnet/1.0.0/gn", colls: ["gatewayBuys", "gatewaySells", "gatewayRedemptions", "gatewayLiquidations", "gatewayWinnerSubmitteds"] },
  { gateway: "0x982a67ae92d8de361957249fb2bb4a62bcc6a8d5", url: "https://api.goldsky.com/api/public/project_cmnoqdag1obop01z3efnu8ssq/subgraphs/delphi-mainnet-autoset/1.0.0/gn", colls: ["gatewayBuys", "gatewaySells", "gatewayRedemptions", "gatewayLiquidations", "gatewayMarketSettleds", "gatewayMarketFaileds", "marketResolutionRequesteds"] },
];

/** Diff our transaction set against Gensyn's subgraphs (where they exist) and pull the missing ones from the node. */
export async function repairFromSubgraphs(log?: (s: string) => void): Promise<NewEvent[]> {
  if (network.name !== "mainnet") return [];
  const missing = new Set<string>();
  for (const s of SUBGRAPHS) {
    const ours = new Set((db.prepare("SELECT DISTINCT tx FROM events WHERE emitter=?").all(s.gateway) as any[]).map((r) => r.tx.toLowerCase()));
    for (const coll of s.colls) {
      let last = "";
      for (;;) {
        const r = await fetch(s.url, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify({ query: `{ ${coll}(first:1000, orderBy:id, where:{id_gt:"${last}"}){ id transactionHash_ } }` }), signal: AbortSignal.timeout(45000) });
        const rows: any[] = ((await r.json()) as any).data?.[coll] ?? [];
        for (const x of rows) if (!ours.has(x.transactionHash_.toLowerCase())) missing.add(x.transactionHash_.toLowerCase());
        if (rows.length < 1000) break;
        last = rows[rows.length - 1].id;
      }
    }
  }
  const fresh = await repairTxs([...missing]);
  log?.(`  subgraph diff: ${missing.size} transactions missing from the explorer, ${fresh.length} events recovered from the node`);
  return fresh;
}

/**
 * Walk the node's own logs for a block range, every Delphi event signature in one filter.
 * Slow on the public endpoint (100 blocks per call) but it needs to trust nothing else. Resumable.
 */
export async function auditRange(opts: { from?: number; to?: number; concurrency?: number; cursorKey?: string; log?: (s: string) => void } = {}): Promise<NewEvent[]> {
  const head = opts.to ?? (await headBlock());
  const firstUnlisted = (db.prepare("SELECT MIN(first_block) b FROM contracts WHERE listed=0").get() as any)?.b as number | null;
  const key = opts.cursorKey ?? "audit";
  const start = opts.from ?? getCursor(key) ?? firstUnlisted ?? head;
  const step = network.rpcMaxLogRange, conc = opts.concurrency ?? 8;
  const topics = [EVENT_DEFS.map((d) => d.topic0)];
  const fresh: NewEvent[] = [];
  let next = start, done = 0;
  const total = Math.ceil((head - start + 1) / step);
  const worker = async () => {
    for (;;) {
      const b = next; if (b > head) return; next += step;
      let rows: any[] = [];
      for (let i = 0; ; i++) {
        try { rows = await rpc<any[]>("eth_getLogs", [{ fromBlock: "0x" + b.toString(16), toBlock: "0x" + Math.min(b + step - 1, head).toString(16), topics }]); break; }
        catch (e) { if (i >= 5) throw e; await new Promise((s) => setTimeout(s, 1000 * (i + 1))); }
      }
      if (rows.length) {
        const raws = await Promise.all(rows.map(toRaw));
        tx(() => { for (const l of raws) { const e = store(l); if (e) fresh.push(e); } });
      }
      if (++done % 500 === 0) { setCursor(key, Math.max(start, next - conc * step)); opts.log?.(`  audit ${done}/${total} ranges, ${fresh.length} recovered`); }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  setCursor(key, head);
  opts.log?.(`  audit complete: blocks ${start}–${head}, ${fresh.length} events the explorer did not have`);
  return fresh;
}
