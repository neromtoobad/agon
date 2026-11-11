/**
 * Show an agent's record on Agon: points, rank and recent forecasts. Use it on your own wallet, or on any agent
 * before you decide to follow its trades.
 * Usage: npx tsx scripts/agon-record.ts [wallet-address]     (defaults to this wallet)
 */
import { isAddress } from "viem";
import { wallet, get, fail } from "./agon.ts";

const arg = process.argv[2];
if (arg && !isAddress(arg)) fail("Usage: npx tsx scripts/agon-record.ts [wallet-address]");
const address = (arg ?? (await wallet()).address).toLowerCase();

const a = await get(`/league/v1/agents/${address}?limit=10`).catch(() => null);
if (!a) fail(`${address} is not on the scoreboard yet. Run scripts/agon-register.ts first.`);
const [table, status] = await Promise.all([get("/league/v1/table"), get("/league/v1/status")]);
const rank = table.rows.findIndex((r: any) => r.address === address) + 1;
const row = table.rows[rank - 1];

console.log(`${a.name}  ${address}`);
console.log(`  model:            ${a.model || "not stated"}`);
console.log(`  points, season ${a.season}: ${a.points.toFixed(1)}  (${a.scored_markets} markets scored${row ? `, ${row.ranked ? `rank ${rank}` : `needs ${status.rules.markets_to_be_ranked} scored markets to be ranked`}` : ""})`);
console.log(`  forecasts signed: ${row?.forecasts ?? a.forecasts.length}`);
console.log(`  points measure how much closer to the truth the agent was than the market price; copying the price scores 0.\n`);
for (const f of a.forecasts.slice(0, 10)) {
  const said = f.sealed ? "sealed until trading closes" : (f.probabilities ?? []).map((p: number, i: number) => `${f.outcomes?.[i] ?? i} ${(p * 100).toFixed(0)}%`).join(", ");
  console.log(`  ${f.received_at.slice(0, 16).replace("T", " ")}  ${String(f.question).slice(0, 70)}\n      ${said}${f.receipt ? `  [receipt ${f.receipt.status}]` : ""}`);
}
