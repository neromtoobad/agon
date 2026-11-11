import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve as nodeServe } from "@hono/node-server";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, getMeta, setMeta, getCursor, setCursor } from "./db.ts";
import { network, PORT, POLL_MS, VERIFY_EVERY_MS, ADMIN_TOKEN, ROOT, lc } from "./config.ts";
import { derive, dueForClock } from "./derive.ts";
import { syncLogs, type NewEvent } from "./ingest.ts";
import { syncRegistry, syncDpmConfig } from "./chain.ts";
import { syncMetadata } from "./metadata.ts";
import { auditRange, repairFromSubgraphs } from "./repair.ts";
import { marketView, eventView, iso, J } from "./views.ts";
import { resolvedRecords, toCsv, toJsonl } from "./export.ts";

const app = new Hono();
app.use("*", cors());

const int = (v: string | undefined, d: number, max: number) => Math.min(Math.max(Number.isFinite(Number(v)) ? Number(v) : d, 0), max);
const addr = (s: string) => (/^0x[0-9a-fA-F]{40}$/.test(s) ? lc(s) : null);
const outcomesOf = (() => { const q = db.prepare("SELECT outcomes FROM markets WHERE address=?"); return (m: string): string[] | null => J((q.get(m) as any)?.outcomes ?? null); })();

// ───────────────────────── status and registry

function statusBody() {
  const one = (q: string, ...a: any[]) => Object.values(db.prepare(q).get(...a) as any)[0] as number;
  const head = getCursor("head") ?? 0, lastTs = one("SELECT COALESCE(MAX(ts),0) FROM events");
  return {
    network: network.name, chain_id: network.chainId, state: getMeta("state") ?? "unknown", indexed_to_block: Math.max(head, getCursor("tail") ?? 0),
    last_event_at: iso(lastTs), markets: one("SELECT COUNT(*) FROM markets"), events: one("SELECT COUNT(*) FROM events"),
    wallets: one("SELECT COUNT(*) FROM wallets"), contracts: one("SELECT COUNT(*) FROM contracts"),
    open_markets: one("SELECT COUNT(*) FROM markets WHERE status='open'"), volume_usd: Math.round(one("SELECT COALESCE(SUM(volume),0) FROM markets")),
    verification: J(getMeta("verification") ?? null),
  };
}
app.get("/health", (c) => c.json({ ok: true }));
app.get("/v1/status", (c) => c.json(statusBody()));
app.get("/v1/verification", (c) => c.json(J(getMeta("verification") ?? null) ?? { error: "run `node src/cli.ts verify` first" }));

app.get("/v1/registry", (c) => {
  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  const contracts = (db.prepare("SELECT * FROM contracts ORDER BY first_block").all() as any[]).map((r) => ({
    address: r.address, role: r.role, mechanism: r.mechanism, paired_factory: r.factory, explorer_name: r.explorer_name, source_verified: !!r.verified,
    listed: !!r.listed, listed_by: r.listed_source, first_event_at: iso(r.first_ts), last_event_at: iso(r.last_ts), first_block: r.first_block, events: r.n_events,
    trades_last_30d: (db.prepare("SELECT COUNT(*) n FROM events WHERE emitter=? AND kind IN ('buy','sell') AND ts>=?").get(r.address, since) as any).n,
  }));
  const gw = contracts.filter((x) => x.role === "gateway"), total = gw.reduce((a, x) => a + x.trades_last_30d, 0), unlisted = gw.filter((x) => !x.listed).reduce((a, x) => a + x.trades_last_30d, 0);
  return c.json({
    network: network.name, discovered_by: "event signature, not address list", official_source: network.listed.sdk.source,
    drift: { trades_last_30d: total, through_unlisted_contracts: unlisted, share_unlisted: total ? Math.round((unlisted / total) * 1000) / 1000 : null,
      note: unlisted ? "Recent trading runs through contracts the official SDK defaults do not name." : "Official SDK defaults cover all recent trading." },
    contracts,
  });
});

// ───────────────────────── markets

app.get("/v1/markets", (c) => {
  const q = c.req.query(), where: string[] = [], args: any[] = [];
  if (q.status) { where.push("status=?"); args.push(q.status); }
  if (q.mechanism) { where.push("mechanism=?"); args.push(q.mechanism); }
  if (q.creator && addr(q.creator)) { where.push("creator=?"); args.push(addr(q.creator)); }
  if (q.q) { where.push("question LIKE ?"); args.push(`%${q.q}%`); }
  const order = ({ volume: "volume DESC", created: "created_block DESC", closing: "trading_deadline ASC", last_trade: "last_trade_ts DESC", resolved: "resolved_ts DESC" } as any)[q.order ?? "created"] ?? "created_block DESC";
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) n FROM markets ${w}`).get(...args) as any).n;
  const rows = db.prepare(`SELECT * FROM markets ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, int(q.limit, 50, 500), int(q.offset, 0, 1e9)) as any[];
  return c.json({ total, markets: rows.map((m) => marketView(m)) });
});

app.get("/v1/markets/:address", (c) => {
  const a = addr(c.req.param("address")); if (!a) return c.json({ error: "bad address" }, 400);
  const m = db.prepare("SELECT * FROM markets WHERE address=?").get(a); if (!m) return c.json({ error: "unknown market" }, 404);
  return c.json(marketView(m, true));
});

app.get("/v1/markets/:address/trades", (c) => {
  const a = addr(c.req.param("address")); if (!a) return c.json({ error: "bad address" }, 400);
  const o = outcomesOf(a);
  const rows = db.prepare("SELECT * FROM events WHERE market=? AND kind!='market_created' ORDER BY block DESC, log_index DESC LIMIT ? OFFSET ?").all(a, int(c.req.query("limit"), 100, 1000), int(c.req.query("offset"), 0, 1e9)) as any[];
  return c.json({ events: rows.map((e) => eventView(e, o)) });
});

app.get("/v1/markets/:address/prices", (c) => {
  const a = addr(c.req.param("address")); if (!a) return c.json({ error: "bad address" }, 400);
  const m = db.prepare("SELECT outcomes, outcome_count, created_ts FROM markets WHERE address=?").get(a) as any; if (!m) return c.json({ error: "unknown market" }, 404);
  const rows = db.prepare("SELECT ts, probs FROM prices WHERE market=? ORDER BY block, log_index").all(a) as any[];
  const n = m.outcome_count ?? 2, step = ({ "1h": 3600, "1d": 86400 } as any)[c.req.query("interval") ?? "raw"] as number | undefined;
  let points = [{ at: iso(m.created_ts), probabilities: Array(n).fill(Math.round(1e6 / n) / 1e6) }, ...rows.map((r) => ({ at: iso(r.ts), probabilities: JSON.parse(r.probs) }))];
  if (step) { // last value in each bucket
    const by = new Map<number, any>();
    for (const p of points) by.set(Math.floor(Date.parse(p.at!) / 1000 / step), p);
    points = [...by.entries()].sort((x, y) => x[0] - y[0]).map(([k, p]) => ({ at: iso((k + 1) * step), probabilities: p.probabilities }));
  }
  return c.json({ market: a, outcomes: J(m.outcomes), points });
});

app.get("/v1/markets/:address/positions", (c) => {
  const a = addr(c.req.param("address")); if (!a) return c.json({ error: "bad address" }, 400);
  const o = outcomesOf(a);
  const rows = db.prepare("SELECT * FROM positions WHERE market=? ORDER BY cost DESC LIMIT ?").all(a, int(c.req.query("limit"), 200, 2000)) as any[];
  return c.json({ positions: rows.map((p) => ({ wallet: p.wallet, outcome: p.outcome_idx, outcome_label: o?.[p.outcome_idx] ?? null, shares: p.shares, cost_usd: p.cost, sold_usd: p.sale_proceeds })) });
});

// ───────────────────────── wallets

const walletView = (w: any) => ({
  address: w.address, first_trade_at: iso(w.first_ts), last_trade_at: iso(w.last_ts), trades: w.n_trades, markets: w.n_markets, volume_usd: w.volume,
  open_exposure_usd: w.open_cost, closed_markets: w.closed_markets, realized_pnl_usd: w.realized_pnl, return_on_closed: w.roi,
  resolved_markets: w.resolved_markets, hit_rate: w.hit_rate, brier: w.brier, markets_created: w.markets_created,
});

app.get("/v1/wallets/:address", (c) => {
  const a = addr(c.req.param("address")); if (!a) return c.json({ error: "bad address" }, 400);
  const w = db.prepare("SELECT * FROM wallets WHERE address=?").get(a); if (!w) return c.json({ error: "no activity for this wallet" }, 404);
  return c.json(walletView(w));
});
app.get("/v1/wallets/:address/markets", (c) => {
  const a = addr(c.req.param("address")); if (!a) return c.json({ error: "bad address" }, 400);
  const rows = db.prepare(`SELECT wm.*, m.question, m.outcomes, m.status, m.winning_outcome FROM wallet_markets wm JOIN markets m ON m.address=wm.market WHERE wm.wallet=? ORDER BY wm.last_ts DESC LIMIT ? OFFSET ?`)
    .all(a, int(c.req.query("limit"), 100, 1000), int(c.req.query("offset"), 0, 1e9)) as any[];
  return c.json({ markets: rows.map((r) => { const o = J(r.outcomes); return {
    market: r.market, question: r.question, status: r.status, backed: r.main_outcome, backed_label: o?.[r.main_outcome] ?? null, winning_label: r.winning_outcome != null ? o?.[r.winning_outcome] ?? null : null,
    won: r.won == null ? null : !!r.won, cost_usd: r.cost, sold_usd: r.sale_proceeds, redeemed_usd: r.redeemed, liquidated_usd: r.liquidated, unredeemed_estimate_usd: r.unredeemed_est,
    pnl_usd: r.pnl, revealed_probability: r.revealed_prob, brier: r.brier, trades: r.n_trades, last_trade_at: iso(r.last_ts) }; }) });
});
app.get("/v1/wallets/:address/trades", (c) => {
  const a = addr(c.req.param("address")); if (!a) return c.json({ error: "bad address" }, 400);
  const rows = db.prepare("SELECT * FROM events WHERE wallet=? AND kind IN ('buy','sell','redeem','liquidate') ORDER BY block DESC, log_index DESC LIMIT ? OFFSET ?").all(a, int(c.req.query("limit"), 100, 1000), int(c.req.query("offset"), 0, 1e9)) as any[];
  return c.json({ events: rows.map((e) => eventView(e, outcomesOf(e.market))) });
});

app.get("/v1/leaderboard", (c) => {
  const q = c.req.query();
  const by = ({ pnl: "realized_pnl DESC", return: "roi DESC", brier: "brier ASC", hit_rate: "hit_rate DESC", volume: "volume DESC" } as any)[q.by ?? "pnl"] ?? "realized_pnl DESC";
  const rows = db.prepare(`SELECT * FROM wallets WHERE resolved_markets >= ? AND closed_cost >= ? ${q.by === "brier" ? "AND brier IS NOT NULL" : ""} ORDER BY ${by} LIMIT ?`)
    .all(int(q.min_resolved, 10, 1e6), int(q.min_cost, 50, 1e9), int(q.limit, 50, 500)) as any[];
  return c.json({ ranked_by: q.by ?? "pnl", definitions: "/v1/definitions", wallets: rows.map(walletView) });
});

app.get("/v1/definitions", (c) => c.json({
  realized_pnl_usd: "For markets that are settled, failed or expired: sales + redemptions + liquidations + estimated value of winning shares not yet redeemed, minus cost. Open markets are excluded.",
  return_on_closed: "realized_pnl_usd divided by the cost of positions in closed markets.",
  hit_rate: "Share of resolved markets where the outcome the wallet spent the most on was the winner.",
  brier: "Cost-weighted mean of (p - o)^2 over the wallet's buys in resolved markets, where p is the market probability of the bought outcome right after the buy and o is 1 if that outcome won. Lower is better; 0.25 is a coin flip on a binary market. p is a revealed lower bound on the trader's belief, not a stated forecast.",
  probabilities: "Replayed from trade events with the contracts' own pricing maths, then checked against the contracts' spot probabilities by `verify`.",
  unredeemed_estimate_usd: "Winning shares still held times the payout per share: $1 on LMSR markets, the observed pool split on pari-mutuel markets.",
}));

// ───────────────────────── trades and settlement

app.get("/v1/trades", (c) => {
  const q = c.req.query(), where = ["kind IN ('buy','sell')"], args: any[] = [];
  if (q.since_block) { where.push("block > ?"); args.push(int(q.since_block, 0, 1e12)); }
  if (q.market && addr(q.market)) { where.push("market=?"); args.push(addr(q.market)); }
  const rows = db.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY block DESC, log_index DESC LIMIT ?`).all(...args, int(q.limit, 100, 1000)) as any[];
  return c.json({ events: rows.map((e) => ({ ...eventView(e, outcomesOf(e.market)) })) });
});

app.get("/v1/settlements", (c) => {
  const rows = db.prepare(`SELECT * FROM markets WHERE status IN ('settled','failed','expired') ORDER BY COALESCE(resolved_ts, settlement_deadline) DESC LIMIT ? OFFSET ?`).all(int(c.req.query("limit"), 100, 1000), int(c.req.query("offset"), 0, 1e9)) as any[];
  return c.json({ settlements: rows.map((m) => ({ ...marketView(m), judge_model: m.judge_model, resolved_tx: m.resolved_tx,
    hours_from_close_to_resolution: m.resolved_ts && m.trading_deadline ? Math.round(((m.resolved_ts - m.trading_deadline) / 3600) * 100) / 100 : null,
    winner_probability_at_close: m.winning_outcome != null && m.close_probs ? JSON.parse(m.close_probs)[m.winning_outcome] : null })) });
});

app.get("/v1/settlement-health", (c) => {
  const rows = db.prepare(`SELECT g.address gateway, g.mechanism, g.listed, m.status, COUNT(*) n,
      AVG(CASE WHEN m.resolved_ts IS NOT NULL AND m.trading_deadline IS NOT NULL THEN (m.resolved_ts - m.trading_deadline)/3600.0 END) avg_h,
      MAX(CASE WHEN m.resolved_ts IS NOT NULL AND m.trading_deadline IS NOT NULL THEN (m.resolved_ts - m.trading_deadline)/3600.0 END) max_h
    FROM markets m JOIN contracts g ON g.address=m.gateway GROUP BY 1,4 ORDER BY g.first_block, m.status`).all() as any[];
  const by = new Map<string, any>();
  for (const r of rows) {
    const g = by.get(r.gateway) ?? { gateway: r.gateway, mechanism: r.mechanism, listed: !!r.listed, markets: 0, by_status: {} as any };
    g.markets += r.n; g.by_status[r.status] = { markets: r.n, avg_hours_from_close: r.avg_h == null ? null : Math.round(r.avg_h * 100) / 100, max_hours_from_close: r.max_h == null ? null : Math.round(r.max_h * 100) / 100 };
    by.set(r.gateway, g);
  }
  for (const g of by.values()) { const closed = (g.by_status.settled?.markets ?? 0) + (g.by_status.failed?.markets ?? 0) + (g.by_status.expired?.markets ?? 0); g.share_without_winner = closed ? Math.round((((g.by_status.failed?.markets ?? 0) + (g.by_status.expired?.markets ?? 0)) / closed) * 1000) / 1000 : null; }
  return c.json({ gateways: [...by.values()] });
});

// ───────────────────────── dataset

let datasetCache: { key: string; rows: any[] } | null = null;
function dataset(path: boolean) {
  const key = `${(db.prepare("SELECT COUNT(*) n FROM events").get() as any).n}:${path}`;
  if (datasetCache?.key !== key) datasetCache = { key, rows: resolvedRecords({ path }) };
  return datasetCache.rows;
}
app.get("/v1/dataset/resolved.jsonl", (c) => c.body(toJsonl(dataset(c.req.query("path") === "1")), 200, { "content-type": "application/x-ndjson" }));
app.get("/v1/dataset/resolved.csv", (c) => c.body(toCsv(dataset(false)), 200, { "content-type": "text/csv" }));

// ───────────────────────── live events: stream and webhooks

export interface LiveEvent { type: string; market: string; question: string | null; [k: string]: any }
const listeners = new Set<(e: LiveEvent) => void>();
const MAX_STREAMS = 500;
const recent: LiveEvent[] = [];

function publish(e: LiveEvent) {
  recent.push(e); if (recent.length > 200) recent.shift();
  for (const l of listeners) l(e);
  for (const h of db.prepare("SELECT * FROM webhooks WHERE failures < 20").all() as any[]) {
    if (h.kinds && !h.kinds.split(",").includes(e.type)) continue;
    const body = JSON.stringify(e);
    fetch(h.url, { method: "POST", headers: { "content-type": "application/json", "x-tripod-signature": "sha256=" + createHmac("sha256", h.secret).update(body).digest("hex") }, body, signal: AbortSignal.timeout(10000) })
      .then((r) => db.prepare("UPDATE webhooks SET last_status=?, last_ts=?, failures=CASE WHEN ? THEN 0 ELSE failures+1 END WHERE id=?").run(r.status, Math.floor(Date.now() / 1000), r.ok ? 1 : 0, h.id))
      .catch(() => db.prepare("UPDATE webhooks SET last_status=0, last_ts=?, failures=failures+1 WHERE id=?").run(Math.floor(Date.now() / 1000), h.id));
  }
}

app.get("/v1/events/recent", (c) => c.json({ events: recent.slice(-int(c.req.query("limit"), 50, 200)).reverse() }));

app.get("/v1/stream", (c) => listeners.size >= MAX_STREAMS ? c.json({ error: "too many open streams, try again shortly" }, 503) : streamSSE(c, async (s) => {
  const q = c.req.query(), kinds = q.kinds?.split(","), market = q.market ? addr(q.market) : null, minMove = Number(q.min_move ?? 0);
  const queue: LiveEvent[] = [];
  let wake: (() => void) | null = null;
  const on = (e: LiveEvent) => {
    if (kinds && !kinds.includes(e.type)) return;
    if (market && e.market !== market) return;
    if (minMove && e.type === "trade" && Math.abs(e.move ?? 0) < minMove) return;
    queue.push(e); wake?.();
  };
  listeners.add(on);
  s.onAbort(() => { listeners.delete(on); wake?.(); });
  await s.writeSSE({ event: "hello", data: JSON.stringify({ network: network.name, kinds: kinds ?? "all" }) });
  while (!s.aborted) {
    while (queue.length) { const e = queue.shift()!; await s.writeSSE({ event: e.type, data: JSON.stringify(e) }); }
    await new Promise<void>((r) => { wake = r; setTimeout(r, 20000); });
    if (!queue.length && !s.aborted) await s.writeSSE({ event: "ping", data: "{}" });
  }
}));

const admin = (c: any) => ADMIN_TOKEN && c.req.header("authorization") === `Bearer ${ADMIN_TOKEN}`;
app.post("/v1/webhooks", async (c) => {
  if (!admin(c)) return c.json({ error: "webhook registration needs the operator's TRIPOD_ADMIN_TOKEN; run your own instance to register freely" }, 401);
  const b = await c.req.json().catch(() => null);
  if (!b?.url || !/^https?:\/\//.test(b.url)) return c.json({ error: "url required" }, 400);
  const secret = randomBytes(24).toString("hex");
  const r = db.prepare("INSERT INTO webhooks(url,secret,kinds,created_ts) VALUES(?,?,?,?)").run(b.url, secret, Array.isArray(b.kinds) ? b.kinds.join(",") : null, Math.floor(Date.now() / 1000));
  return c.json({ id: Number(r.lastInsertRowid), secret, note: "Each delivery carries x-tripod-signature: sha256=HMAC(secret, body)." });
});
app.get("/v1/webhooks", (c) => admin(c) ? c.json({ webhooks: db.prepare("SELECT id,url,kinds,created_ts,last_status,last_ts,failures FROM webhooks").all() }) : c.json({ error: "unauthorized" }, 401));
app.delete("/v1/webhooks/:id", (c) => { if (!admin(c)) return c.json({ error: "unauthorized" }, 401); db.prepare("DELETE FROM webhooks WHERE id=?").run(Number(c.req.param("id"))); return c.json({ ok: true }); });

/** Turn freshly stored chain events into the public event shape, with the price move each trade caused. */
function toLive(fresh: NewEvent[]): LiveEvent[] {
  const qM = db.prepare("SELECT question, outcomes, outcome_count, probs, status FROM markets WHERE address=?");
  const qP = db.prepare("SELECT probs FROM prices WHERE market=? AND block=? AND log_index=?");
  const qPrev = db.prepare("SELECT probs FROM prices WHERE market=? AND (block<? OR (block=? AND log_index<?)) ORDER BY block DESC, log_index DESC LIMIT 1");
  return fresh.map((e) => {
    const m = qM.get(e.market) as any, o: string[] | null = J(m?.outcomes ?? null);
    const base: LiveEvent = { type: e.kind, market: e.market, question: m?.question ?? null, block: e.block, at: iso(e.ts), tx: e.tx };
    if (e.kind === "buy" || e.kind === "sell") {
      const after: number[] | null = J((qP.get(e.market, e.block, e.logIndex) as any)?.probs ?? null);
      const n = m?.outcome_count ?? 2, before: number[] = J((qPrev.get(e.market, e.block, e.block, e.logIndex) as any)?.probs ?? null) ?? Array(n).fill(1 / n);
      const i = e.outcomeIdx!;
      return { ...base, type: "trade", side: e.kind, wallet: e.wallet, outcome: i, outcome_label: o?.[i] ?? null, usd: Number(e.tokens) / 1e6, shares: Number(e.shares) / 1e18,
        probability_before: before[i], probability_after: after?.[i] ?? null, move: after ? Math.round((after[i] - before[i]) * 1e6) / 1e6 : null, probabilities: after };
    }
    if (e.kind === "market_created") return { ...base, creator: e.wallet, outcomes: o };
    if (e.kind === "settled") return { ...base, winning_outcome: e.outcomeIdx, winning_label: o?.[e.outcomeIdx!] ?? null };
    if (e.kind === "redeem" || e.kind === "liquidate") return { ...base, wallet: e.wallet, usd: Number(e.tokens) / 1e6 };
    return { ...base, wallet: e.wallet ?? undefined };
  });
}

// ───────────────────────── live loop

async function tick() {
  const tail = getCursor("tail");
  const fresh = await auditRange({ from: tail === undefined ? (getCursor("head") ?? 0) - 300 : tail - 30, cursorKey: "tail", concurrency: 4 });
  const before = new Map((db.prepare("SELECT address, status FROM markets WHERE status IN ('open','awaiting_settlement')").all() as any[]).map((r) => [r.address, r.status]));
  if (fresh.some((e) => e.kind === "market_created") || (db.prepare("SELECT COUNT(*) n FROM contracts WHERE role='gateway' AND factory IS NULL").get() as any).n) {
    await syncRegistry(); await syncDpmConfig();
  }
  await syncMetadata(undefined, 6);
  const touched = new Set([...fresh.map((e) => e.market), ...dueForClock(), ...(db.prepare("SELECT address FROM markets WHERE status IS NULL").all() as any[]).map((r) => r.address)]);
  if (touched.size) derive(touched);
  for (const e of toLive(fresh)) publish(e);
  for (const a of touched) { // clock-driven transitions have no chain event of their own
    const m = db.prepare("SELECT status, question FROM markets WHERE address=?").get(a) as any, was = before.get(a);
    if (was === "open" && m.status === "awaiting_settlement") publish({ type: "trading_closed", market: a, question: m.question, at: new Date().toISOString() });
    if (was && m.status === "expired") publish({ type: "expired", market: a, question: m.question, at: new Date().toISOString() });
  }
  return fresh.length;
}

app.get("/", (c) => c.html(readFileSync(join(ROOT, "public", "index.html"), "utf8")));

async function backfill() {
  setMeta("state", "backfilling");
  console.log("backfilling (a few minutes on an empty database)…");
  await syncLogs({ log: console.log }); await syncRegistry(console.log); await syncDpmConfig(console.log); await syncMetadata(console.log);
  await repairFromSubgraphs(console.log).catch((e) => console.error("repair skipped:", (e as Error).message));
  derive();
}

async function runVerify() {
  try { const { verify } = await import("./verify.ts"); await verify(); }
  catch (e) { console.error("verify failed to run:", (e as Error).message); }
}

export async function serve(opts: { live: boolean }) {
  // Listen first so a host's health check passes while a first-run backfill is still going.
  nodeServe({ fetch: app.fetch, port: PORT });
  console.log(`tripod listening on http://localhost:${PORT} (${network.name}${opts.live ? ", live" : ", read-only"})`);
  if (!opts.live) return;
  try {
    // "live" is only written once a backfill has completed, so a restart part-way through resumes it (cursors make that cheap).
    if (getMeta("state") !== "live") await backfill();
    setMeta("state", "live");
  } catch (e) { console.error("backfill failed, will retry on restart:", (e as Error).message); process.exit(1); }
  const loop = async () => {
    try { const n = await tick(); if (n) console.log(`${new Date().toISOString()} +${n} events`); }
    catch (e) { console.error("tick failed:", (e as Error).message); }
    setTimeout(loop, POLL_MS);
  };
  loop();
  setTimeout(runVerify, 60_000);
  setInterval(runVerify, VERIFY_EVERY_MS);
}
void setCursor;
