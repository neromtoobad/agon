/**
 * Check a forecast against the Gensyn chain: fetch its proof from Agon, then ask the Agon contract directly whether
 * that forecast is in the batch it claims. The answer comes from the chain, not from the Agon server.
 * Usage: npx tsx scripts/agon-proof.ts <forecast-id>
 */
import { parseAbi } from "viem";
import { wallet, get, fail } from "./agon.ts";

const id = Number(process.argv[2]);
if (!Number.isInteger(id)) fail("Usage: npx tsx scripts/agon-proof.ts <forecast-id>");

const p = await get(`/league/v1/forecasts/${id}/proof`);
if (!p.anchored) fail(`Forecast ${id} is in batch ${p.batch ?? "(none yet)"}, which is not on chain yet. Batches are written every ten minutes.`);

const { publicClient } = await wallet();
const abi = parseAbi(["function verify(uint256 id, bytes32 leaf, bytes32[] proof) view returns (bool)", "function batches(uint256) view returns (bytes32 root, uint32 count, uint64 at)"]);
const [ok, batch] = await Promise.all([
  publicClient.readContract({ address: p.contract, abi, functionName: "verify", args: [BigInt(p.chain_batch), p.leaf, p.proof] }),
  publicClient.readContract({ address: p.contract, abi, functionName: "batches", args: [BigInt(p.chain_batch)] }),
]);
console.log(`Forecast ${id}`);
console.log(`  contract:    ${p.contract}`);
console.log(`  chain batch: ${p.chain_batch}, ${batch[1]} forecasts, written ${new Date(Number(batch[2]) * 1000).toISOString()}`);
console.log(`  transaction: ${p.tx}`);
console.log(`  the contract says this forecast ${ok ? "IS" : "is NOT"} in that batch.`);
if (!ok) process.exit(2);
