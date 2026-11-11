import { createWalletClient, createPublicClient, http, defineChain, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { db } from "../db.ts";
import { network, lc } from "../config.ts";
import { buildBatch } from "./core.ts";

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
]);

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
