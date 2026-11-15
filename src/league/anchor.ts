import { createWalletClient, createPublicClient, http, defineChain, parseAbi, decodeEventLog, toEventSelector, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { db, getMeta, setMeta } from "../db.ts";
import { logsByTopic, headBlock } from "../sources/logs.ts";
import { network, lc } from "../config.ts";
import { buildBatch, Refused } from "./core.ts";

/**
 * Puts batch roots on chain. Anchoring is optional at runtime: without a contract address and a funded key
 * the scoreboard still works, and its batches are reported as "not on chain yet" so nobody is misled.
 *
 *   AGON_CONTRACT     address of the deployed Agon contract
 *   AGON_ANCHOR_KEY   private key of the contract's anchorer (needs a little ETH on Gensyn)
 *   AGON_RPC_URL      optional; defaults to the network RPC
 */
export const AGON_ABI = parseAbi([
  "function anchor(bytes32 root, uint32 count) returns (uint256 id)",
  "function batchCount() view returns (uint256)",
  "function batches(uint256) view returns (bytes32 root, uint32 count, uint64 at)",
  "function verify(uint256 id, bytes32 leaf, bytes32[] proof) view returns (bool)",
  "function anchorer() view returns (address)",
  "event Anchored(uint256 indexed batch, bytes32 root, uint32 count)",
  "event Committed(address indexed agent, bytes32 leaf)",
  "function commit(bytes32 leaf)",
]);
const COMMITTED = toEventSelector("event Committed(address indexed agent, bytes32 leaf)");

const CONTRACT = process.env.AGON_CONTRACT as Hex | undefined;
const KEY = process.env.AGON_ANCHOR_KEY as Hex | undefined;
const RPC = process.env.AGON_RPC_URL ?? network.rpcUrl;
const chain = defineChain({ id: network.chainId, name: `Gensyn ${network.name}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });

export const anchoring = () => ({ configured: !!(CONTRACT && KEY), contract: CONTRACT ? lc(CONTRACT) : null, chain_id: network.chainId });
export const agonPublic = () => createPublicClient({ chain, transport: http(RPC, { timeout: 45000 }) });

/** Build a batch from new forecasts, then send every unanchored batch to the contract, oldest first. */
export async function anchorPending(log?: (s: string) => void) {
  const built = buildBatch();
  if (built) log?.(`batch ${built.id}: ${built.count} forecasts, root ${built.root}`);
  if (!CONTRACT || !KEY) return { built, anchored: 0 };
  const account = privateKeyToAccount(KEY);
  const wallet = createWalletClient({ account, chain, transport: http(RPC, { timeout: 45000 }) }), pub = agonPublic();
  let n = 0;
  for (const b of db.prepare("SELECT * FROM league_batches WHERE anchored = 0 ORDER BY id").all() as any[]) {
    const chainBatch = Number(await pub.readContract({ address: CONTRACT, abi: AGON_ABI, functionName: "batchCount" }));
    const hash = await wallet.writeContract({ address: CONTRACT, abi: AGON_ABI, functionName: "anchor", args: [b.root as Hex, b.count] });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (rc.status !== "success") throw new Error(`anchor transaction ${hash} reverted`);
    db.prepare("UPDATE league_batches SET anchored = 1, chain_batch = ?, tx = ?, block = ?, contract = ? WHERE id = ?").run(chainBatch, hash, Number(rc.blockNumber), lc(CONTRACT), b.id);
    log?.(`batch ${b.id} anchored as on-chain batch ${chainBatch} in ${hash}`);
    n++;
  }
  return { built, anchored: n };
}

// ───────────────────────── commits an agent makes itself

const saveCommit = db.prepare("INSERT OR IGNORE INTO league_commits(tx, log_index, block, ts, agent, leaf) VALUES(?,?,?,?,?,?)");

/**
 * Read Committed(agent, leaf) events from the Agon contract, from where the last scan stopped to the chain head.
 * An agent's wallet calls commit(leaf) just before it trades; the block that holds it dates the forecast on chain,
 * without relying on this server's clock or its ten-minute batches.
 */
export async function scanCommits(log?: (s: string) => void) {
  if (!CONTRACT) return { seen: 0 };
  const head = await headBlock();
  const first = Number(process.env.AGON_CONTRACT_BLOCK ?? (db.prepare("SELECT MIN(block) b FROM league_batches WHERE block IS NOT NULL").get() as any)?.b ?? head) - 5000;
  const from = Number(getMeta("commit_scan_block") ?? Math.max(0, first));
  let seen = 0;
  for await (const rows of logsByTopic(COMMITTED, from, head, "explorer")) {
    for (const r of rows) {
      if (r.address !== lc(CONTRACT)) continue;
      const ev = decodeEventLog({ abi: AGON_ABI, data: r.data as Hex, topics: r.topics as [Hex, ...Hex[]] }) as any;
      saveCommit.run(r.transactionHash.toLowerCase(), r.logIndex, r.blockNumber, r.timestamp || null, lc(ev.args.agent), String(ev.args.leaf).toLowerCase());
      seen++;
    }
  }
  setMeta("commit_scan_block", String(Math.max(from, head - 50))); // re-read the last few blocks next time, in case the explorer lags
  if (seen) log?.(`commits: ${seen} seen up to block ${head}`);
  return { seen };
}

/** Record the commit in one transaction now, rather than waiting for the next scan. Anyone may report one: it is checked on chain. */
export async function reportCommit(forecastId: number, txHash: string) {
  if (!CONTRACT) throw new Refused("this server has no Agon contract configured");
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash ?? "")) throw new Refused("tx must be a transaction hash");
  const f = db.prepare("SELECT id, agent, leaf FROM league_forecasts WHERE id = ?").get(forecastId) as any;
  if (!f) throw Object.assign(new Refused("no such forecast"), { status: 404 });
  const pub = agonPublic();
  const rc = await pub.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null);
  if (!rc) throw new Refused("that transaction is not on chain yet");
  if (rc.status !== "success") throw new Refused("that transaction reverted");
  const hit = rc.logs.find((l) => lc(l.address) === lc(CONTRACT) && l.topics[0] === COMMITTED && (() => {
    const ev = decodeEventLog({ abi: AGON_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as any;
    return lc(ev.args.agent) === f.agent && String(ev.args.leaf).toLowerCase() === f.leaf;
  })());
  if (!hit) throw new Refused("that transaction has no commit of this forecast's leaf by this agent");
  const blk = await pub.getBlock({ blockNumber: rc.blockNumber });
  saveCommit.run(txHash.toLowerCase(), Number(hit.logIndex), Number(rc.blockNumber), Number(blk.timestamp), f.agent, f.leaf);
  return { forecast: f.id, tx: txHash.toLowerCase(), block: Number(rc.blockNumber), at: new Date(Number(blk.timestamp) * 1000).toISOString() };
}
