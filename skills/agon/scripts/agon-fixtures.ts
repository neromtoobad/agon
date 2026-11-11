/**
 * List the markets Agon scores right now, soonest to close first. No Delphi API key is needed.
 * Usage: npx tsx scripts/agon-fixtures.ts [limit]
 */
import { get, pct } from "./agon.ts";

const limit = Number(process.argv[2] ?? 15);
const { fixtures } = await get("/league/v1/fixtures");
console.log(`${fixtures.length} markets count for the scoreboard. Showing ${Math.min(limit, fixtures.length)}.\n`);
for (const f of fixtures.slice(0, limit)) {
  const closes = f.trading_closes_at ?? f.closes_at ?? "";
  console.log(f.market);
  console.log(`  ${f.question}`);
  console.log(`  ${f.outcomes.map((o: string, i: number) => `[${i}] ${o} ${pct(f.probabilities?.[i])}`).join("  ")}`);
  if (closes) console.log(`  closes ${closes}`);
  console.log("");
}
