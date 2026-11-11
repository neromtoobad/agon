import { derive as runDerive } from "./derive.ts";
import { db } from "./db.ts";

const log = (s: string) => console.log(s);

export async function derive() {
  const t = Date.now();
  const n = runDerive();
  log(`derived ${n} markets in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  const one = (q: string) => Object.values(db.prepare(q).get() as any)[0];
  log(`price points ${one("SELECT COUNT(*) FROM prices")} · positions ${one("SELECT COUNT(*) FROM positions")} · wallets ${one("SELECT COUNT(*) FROM wallets")}`);
  for (const r of db.prepare("SELECT mechanism, status, COUNT(*) n, ROUND(SUM(volume)) v FROM markets GROUP BY 1,2 ORDER BY 1,2").all() as any[]) log(`  ${r.mechanism} ${String(r.status).padEnd(20)} ${String(r.n).padStart(4)} markets  $${r.v}`);
}

export async function repair() {
  const { repairFromSubgraphs } = await import("./repair.ts");
  const fresh = await repairFromSubgraphs(log);
  if (fresh.length) { runDerive(new Set(fresh.map((e) => e.market))); for (const e of fresh) log(`  recovered ${e.kind} block ${e.block} tx ${e.tx}`); }
}
export async function audit(args: string[]) {
  const { auditRange } = await import("./repair.ts");
  const num = (k: string) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : undefined; };
  const fresh = await auditRange({ from: num("--from"), to: num("--to"), concurrency: num("--concurrency"), log });
  if (fresh.length) runDerive(new Set(fresh.map((e) => e.market)));
}
export async function verify(args: string[]) { const m = await import("./verify.ts"); await m.verify(args); }
export async function serve() { const m = await import("./server.ts"); await m.serve({ live: false }); }
export async function start() { const m = await import("./server.ts"); await m.serve({ live: true }); }
async function exp(args: string[]) { const m = await import("./export.ts"); await m.exportDataset(args[0]); }
export { exp as export };
