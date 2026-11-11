import { db } from "./db.ts";
import { network, DB_PATH, LOG_SOURCE } from "./config.ts";
import { syncLogs } from "./ingest.ts";
import { syncRegistry, syncDpmConfig } from "./chain.ts";
import { syncMetadata } from "./metadata.ts";

const log = (s: string) => console.log(s);
const cmd = process.argv[2] ?? "status";

export async function syncAll(quiet = false) {
  const l = quiet ? undefined : log;
  const fresh = await syncLogs({ log: l });
  await syncRegistry(l);
  await syncDpmConfig(l);
  await syncMetadata(l);
  return fresh;
}

function status() {
  const one = (q: string) => Object.values(db.prepare(q).get() as any)[0];
  log(`tripod · ${network.name} · ${DB_PATH}`);
  log(`head block ${one("SELECT COALESCE((SELECT block FROM cursors WHERE key='head'),0)")} · source ${LOG_SOURCE}`);
  log(`contracts ${one("SELECT COUNT(*) FROM contracts")} · markets ${one("SELECT COUNT(*) FROM markets")} · events ${one("SELECT COUNT(*) FROM events")}`);
  for (const r of db.prepare("SELECT role, mechanism, address, listed, explorer_name, n_events, factory, date(first_ts,'unixepoch') f, date(last_ts,'unixepoch') l FROM contracts ORDER BY first_block").all() as any[])
    log(`  ${r.role.padEnd(7)} ${String(r.mechanism).padEnd(4)} ${r.address} ${r.listed ? "listed  " : "UNLISTED"} ${String(r.explorer_name ?? "?").padEnd(26)} ${String(r.n_events).padStart(6)} events  ${r.f} → ${r.l}`);
  for (const r of db.prepare("SELECT kind, COUNT(*) n FROM events GROUP BY kind ORDER BY n DESC").all() as any[]) log(`  ${r.kind.padEnd(22)} ${r.n}`);
}

if (cmd === "sync") {
  const t = Date.now();
  const fresh = await syncAll();
  log(`synced: ${fresh.length} new events in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  status();
} else if (cmd === "status") {
  status();
} else if (["derive", "serve", "start", "export", "verify", "repair", "audit"].includes(cmd)) {
  const m = await import("./commands.ts");
  await (m as any)[cmd](process.argv.slice(3));
} else {
  log("usage: node src/cli.ts <sync|derive|repair|audit|verify|serve|start|export|status>");
  process.exit(1);
}
