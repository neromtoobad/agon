import { createHash } from "node:crypto";
import { db } from "./db.ts";
import { UA } from "./config.ts";

const up = db.prepare(`UPDATE markets SET metadata_verified=?, metadata_raw=?, question=?, outcomes=?, criteria=?, data_sources=?, judge_model=?, category=?,
  outcome_count=COALESCE(outcome_count, ?) WHERE address=?`);

async function one(m: { address: string; metadata_uri: string; metadata_hash: string }) {
  let buf: Buffer;
  try {
    const r = await fetch(m.metadata_uri, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) { if (r.status === 404 || r.status === 403) db.prepare("UPDATE markets SET metadata_verified=-1 WHERE address=?").run(m.address); return; }
    buf = Buffer.from(await r.arrayBuffer());
  } catch { return; } // transient; retried on the next pass
  // The factory stores sha256 of the metadata file next to its URL, so the text can be checked against the chain.
  const ok = "0x" + createHash("sha256").update(buf).digest("hex") === m.metadata_hash.toLowerCase() ? 1 : 0;
  let j: any = null;
  try { j = JSON.parse(buf.toString("utf8")); } catch { /* keep raw */ }
  const outcomes = Array.isArray(j?.outcomes) ? j.outcomes.map((o: any) => (typeof o === "string" ? o : o?.name ?? o?.label ?? String(o))) : null;
  const criteria = j?.model?.prompt_context ?? j?.resolutionCriteria ?? j?.resolution_criteria ?? j?.settlement_criteria ?? j?.description ?? null;
  const sources = j?.data_sources ?? j?.dataSources ?? null;
  up.run(ok, buf.toString("utf8").slice(0, 200000), j?.question ?? j?.title ?? null, outcomes ? JSON.stringify(outcomes) : null,
    typeof criteria === "string" ? criteria : criteria ? JSON.stringify(criteria) : null, sources ? JSON.stringify(sources) : null,
    j?.model?.model_identifier ?? j?.model_identifier ?? (typeof j?.model === "string" ? j.model : null), j?.category ?? null,
    outcomes ? outcomes.length : null, m.address);
}

export async function syncMetadata(log?: (s: string) => void, concurrency = 12) {
  const rows = db.prepare("SELECT address, metadata_uri, metadata_hash FROM markets WHERE metadata_verified IS NULL AND metadata_uri LIKE 'http%'").all() as any[];
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < rows.length) { await one(rows[i++]); if (++done % 100 === 0) log?.(`  metadata: ${done}/${rows.length}`); }
  }));
  if (rows.length) log?.(`  metadata: ${rows.length} fetched`);
}
