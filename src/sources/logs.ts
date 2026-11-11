import { network, UA } from "../config.ts";
import type { RawLog } from "../events.ts";

async function fetchJson(url: string, init?: RequestInit, tries = 4): Promise<any> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { "user-agent": UA, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(45000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 90)}`);
      return await r.json();
    } catch (e) { last = e; await new Promise((s) => setTimeout(s, 800 * (i + 1))); }
  }
  throw last;
}

let rpcId = 0, coolUntil = 0, strikes = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * JSON-RPC with shared back-off: when the node answers 429 every caller pauses, and the pause grows
 * while the node keeps refusing. Lets long scans run against the free public endpoint without failing.
 */
export async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 12; i++) {
    const wait = coolUntil - Date.now();
    if (wait > 0) await sleep(wait + Math.random() * 250);
    try {
      const r = await fetch(network.rpcUrl, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }), signal: AbortSignal.timeout(45000) });
      if (r.status === 429) {
        strikes = Math.min(strikes + 1, 6);
        coolUntil = Math.max(coolUntil, Date.now() + (Number(r.headers.get("retry-after")) * 1000 || 1000 * 2 ** strikes));
        last = new Error("HTTP 429"); continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j: any = await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      if (strikes && Math.random() < 0.1) strikes--;
      return j.result as T;
    } catch (e) { last = e; if ((e as Error).message.startsWith(method)) throw e; await sleep(600 * (i + 1)); }
  }
  throw last;
}
export const headBlock = async () => Number(await rpc<string>("eth_blockNumber", []));

const blockTs = new Map<number, number>();
async function tsOf(block: number): Promise<number> {
  let t = blockTs.get(block);
  if (t === undefined) { t = Number((await rpc<any>("eth_getBlockByNumber", ["0x" + block.toString(16), false])).timestamp); blockTs.set(block, t); }
  return t;
}

const hex = (n: number) => "0x" + n.toString(16);

/**
 * All logs carrying `topic0` from any contract, block range inclusive, oldest first.
 * Explorer: the block explorer's Etherscan-style endpoint, 1,000 logs per page and no range cap.
 * RPC: plain eth_getLogs in chunks the node allows (100 blocks on the public endpoint).
 */
export async function* logsByTopic(topic0: string, from: number, to: number, source: "explorer" | "rpc"): AsyncGenerator<RawLog[]> {
  if (source === "explorer") {
    let cursor = from;
    for (;;) {
      const j = await fetchJson(`${network.explorerUrl}/api?module=logs&action=getLogs&fromBlock=${cursor}&toBlock=${to}&topic0=${topic0}`);
      const rows: any[] = Array.isArray(j.result) ? j.result : [];
      if (!rows.length) return;
      const out: RawLog[] = rows.map((r) => ({
        address: String(r.address).toLowerCase(), topics: (r.topics as (string | null)[]).filter((t): t is string => !!t), data: r.data,
        blockNumber: Number(r.blockNumber), logIndex: Number(r.logIndex), transactionHash: r.transactionHash, timestamp: Number(r.timeStamp),
      }));
      yield out;
      if (rows.length < 1000) return;
      const last = out[out.length - 1].blockNumber;
      cursor = last === cursor ? last + 1 : last; // re-read the boundary block; primary key drops repeats
    }
  } else {
    const step = network.rpcMaxLogRange;
    for (let b = from; b <= to; b += step) {
      const rows = await rpc<any[]>("eth_getLogs", [{ fromBlock: hex(b), toBlock: hex(Math.min(b + step - 1, to)), topics: [topic0] }]);
      if (!rows.length) continue;
      const out: RawLog[] = [];
      for (const r of rows) out.push({
        address: String(r.address).toLowerCase(), topics: r.topics, data: r.data, blockNumber: Number(r.blockNumber), logIndex: Number(r.logIndex),
        transactionHash: r.transactionHash, timestamp: r.blockTimestamp ? Number(r.blockTimestamp) : await tsOf(Number(r.blockNumber)),
      });
      yield out;
    }
  }
}

export async function explorerContract(address: string): Promise<{ name?: string; verified?: boolean }> {
  try {
    const j = await fetchJson(`${network.explorerUrl}/api/v2/smart-contracts/${address}`, undefined, 2);
    return { name: j.name, verified: !!j.is_verified };
  } catch { return {}; }
}
