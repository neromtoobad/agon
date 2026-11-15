import type { Hono } from "hono";
import { db } from "../db.ts";
import { lc } from "../config.ts";
import { J, probsAt, eventView } from "../views.ts";
import {
  DOMAIN, TYPES, Refused, registerAgent, submitForecast, submitLocked, agentView, USABLE, forecastView, proofFor, openFixtures, fixture,
  forecasterTable, traderTable, modelTable, submitVerification, strictPrompt, receiptView, seasonOf, seasonWindow, RANK_MIN_FORECAST, RANK_MIN_TRADES, RANK_MIN_COST, MIN_FIXTURE_SECONDS,
} from "./core.ts";
import { anchoring, reportCommit } from "./anchor.ts";

const iso = (t: number | null) => (t ? new Date(t * 1000).toISOString() : null);
const addr = (s: string) => (/^0x[0-9a-fA-F]{40}$/.test(s) ? lc(s) : null);
const int = (v: string | undefined, d: number, max: number) => Math.min(Math.max(Number.isFinite(Number(v)) ? Number(v) : d, 0), max);
const count = (q: string, ...a: any[]) => Object.values(db.prepare(q).get(...a) as any)[0] as number;

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * An agent's record, market by market: what it said, the market price when it said it, what its wallet then traded
 * (read from the chain, so trades cannot be left out), and how the market ended.
 * `summary.buys_with_belief` counts the wallet's buys that had a forecast on record first.
 */
function recordOf(a: string, fs: any[], scores: any[]) {
  const evs = db.prepare("SELECT * FROM events WHERE wallet = ? AND kind IN ('buy','sell','redeem','liquidate') ORDER BY block, log_index").all(a) as any[];
  const firstSaid = new Map((db.prepare(`SELECT market, MIN(received_ts) t FROM league_forecasts WHERE agent = ? AND COALESCE(lock_state, '') != 'failed' GROUP BY market`).all(a) as any[]).map((r) => [r.market, r.t as number]));
  // The agent's earliest on-chain commit per market: a trade after it is provably after a belief, by block order alone.
  const firstCommit = new Map((db.prepare(`SELECT f.market, c.block, c.log_index FROM league_commits c JOIN league_forecasts f ON f.leaf = c.leaf AND f.agent = c.agent
    WHERE f.agent = ? AND COALESCE(f.lock_state, '') != 'failed' ORDER BY c.block DESC, c.log_index DESC`).all(a) as any[]).map((r) => [r.market, [r.block as number, r.log_index as number]]));
  const committedBefore = (e: any) => { const c = firstCommit.get(e.market); return !!c && (e.block > c[0] || (e.block === c[0] && e.log_index > c[1])); };
  const ledger = new Map((db.prepare("SELECT * FROM wallet_markets WHERE wallet = ?").all(a) as any[]).map((r) => [r.market, r]));
  const score = new Map(scores.map((s) => [s.market, s]));
  const by = new Map<string, any[]>();
  for (const f of fs) (by.get(f.market) ?? by.set(f.market, []).get(f.market)!).push(f); // newest first
  const markets = [...by.entries()].map(([market, list]) => {
    const f = list[0], outcomes = J(f.outcomes) as string[] | null, w = ledger.get(market);
    const trades = evs.filter((e) => e.market === market).map((e) => { const v = eventView(e, outcomes); return { kind: v.kind, outcome: v.outcome, outcome_label: v.outcome_label, usd: v.usd, shares: v.shares, price: v.price, at: v.at, tx: v.tx, after_forecast: e.ts == null || e.ts >= (firstSaid.get(market) ?? Infinity), committed_first: committedBefore(e) }; });
    return {
      market, question: f.question, outcomes, status: f.status, trading_closes_at: iso(f.d),
      winning_outcome: f.status === "settled" ? f.winning_outcome : null,
      forecasts: list.length, first_forecast_at: iso(firstSaid.get(market) ?? null),
      latest: forecastView(f, f.d),
      market_probabilities_then: probsAt(market, f.received_ts) ?? Array(f.n).fill(1 / f.n), // the market's price when the latest forecast arrived
      score: score.get(market) ?? null,
      trades,
      position: w ? { cost_usd: r6(w.cost), returned_usd: r6(w.sale_proceeds + w.redeemed + w.liquidated), pnl_usd: w.closed && w.pnl != null ? r6(w.pnl) : null, trades: w.n_trades } : null,
    };
  });
  const buys = evs.filter((e) => e.kind === "buy");
  const cover = scores.reduce((n, s) => n + s.coverage, 0);
  const closed = [...ledger.values()].filter((w) => w.closed && w.pnl != null);
  return {
    summary: {
      markets_forecast: firstSaid.size,
      sealed_now: fs.filter((f) => (f.visibility === 0 && Date.now() / 1000 < f.d) || (f.visibility === 2 && f.lock_state === "locked")).length,
      timelocked: fs.filter((f) => f.visibility === 2).length,
      could_not_open: fs.filter((f) => f.lock_state === "failed").length,
      committed_on_chain: fs.filter((f) => f.commit_tx).length,
      buys: buys.length,
      buys_with_belief: buys.filter((e) => firstSaid.has(e.market) && (e.ts == null || e.ts >= firstSaid.get(e.market)!)).length,
      buys_committed_first: buys.filter(committedBefore).length,
      traded_markets: ledger.size, spent_usd: r6([...ledger.values()].reduce((n, w) => n + w.cost, 0)),
      realized_pnl_usd: closed.length ? r6(closed.reduce((n, w) => n + w.pnl, 0)) : null,
      // Weighted by coverage, the same weight the points use, so these two numbers and the points always agree in sign.
      agent_brier: cover > 0 ? r6(scores.reduce((n, s) => n + s.agent_brier * s.coverage, 0) / cover) : null,
      market_brier: cover > 0 ? r6(scores.reduce((n, s) => n + s.market_brier * s.coverage, 0) / cover) : null,
    },
    markets,
  };
}

const agentForecasts = (a: string, limit: number) => db.prepare(`SELECT f.*, m.trading_deadline d, m.question, m.outcomes, m.status, m.winning_outcome, m.outcome_count n,
    (SELECT c.tx FROM league_commits c WHERE c.leaf = f.leaf AND c.agent = f.agent LIMIT 1) commit_tx
  FROM league_forecasts f JOIN markets m ON m.address = f.market WHERE f.agent = ? ORDER BY f.id DESC LIMIT ?`).all(a, limit) as any[];

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
/** A small badge in the usual README style. Width is estimated from character counts (Verdana 11px, about 7px a character). */
function badgeSvg(label: string, value: string, color: string) {
  const w = (t: string) => Math.round(t.length * 6.6) + 12, lw = w(label), vw = w(value), W = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${W}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#2b2b2b"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${W}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text><text x="${lw / 2}" y="14">${esc(label)}</text>
<text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(value)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

export function mountLeague(app: Hono) {
  // Writes are limited per caller address so one client cannot flood the record. Reads are not limited here.
  const WRITES_PER_MINUTE = Number(process.env.AGON_WRITES_PER_MINUTE ?? 300), hits = new Map<string, number[]>();
  const tooMany = (c: any) => {
    const ip = (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim() || "local", t = Date.now();
    const recent = (hits.get(ip) ?? []).filter((x) => t - x < 60_000);
    recent.push(t); hits.set(ip, recent);
    if (hits.size > 10_000) hits.clear();
    return recent.length > WRITES_PER_MINUTE;
  };
  const guard = (fn: (c: any) => Promise<any>) => async (c: any) => {
    if (tooMany(c)) return c.json({ error: `too many writes from this address: the limit is ${WRITES_PER_MINUTE} a minute` }, 429);
    try { return c.json(await fn(c)); }
    catch (e) { if (e instanceof Refused) return c.json({ error: e.message }, (e as any).status ?? 400); throw e; }
  };

  app.get("/league/v1/status", (c) => {
    const s = seasonOf(Math.floor(Date.now() / 1000)), w = seasonWindow(s);
    const batches = db.prepare("SELECT COUNT(*) n, SUM(anchored) a FROM league_batches").get() as any;
    return c.json({
      season: s, season_starts: iso(w.starts), season_ends: iso(w.ends),
      agents: count("SELECT COUNT(*) FROM league_agents"), forecasts: count("SELECT COUNT(*) FROM league_forecasts"),
      sealed_now: count("SELECT COUNT(*) FROM league_forecasts f JOIN markets m ON m.address = f.market WHERE (f.visibility = 0 AND m.trading_deadline > ?) OR (f.visibility = 2 AND f.lock_state = 'locked')", Math.floor(Date.now() / 1000)),
      timelocked: count("SELECT COUNT(*) FROM league_forecasts WHERE visibility = 2"),
      committed_on_chain: count("SELECT COUNT(DISTINCT f.id) FROM league_forecasts f JOIN league_commits c ON c.leaf = f.leaf AND c.agent = f.agent"),
      scored_markets: count("SELECT COUNT(DISTINCT market) FROM league_scores"), open_fixtures: openFixtures().length,
      batches: batches.n, batches_on_chain: batches.a ?? 0, waiting_for_batch: count("SELECT COUNT(*) FROM league_forecasts WHERE batch IS NULL"),
      anchoring: anchoring(),
      rules: { fixture_min_hours_open: MIN_FIXTURE_SECONDS / 3600, markets_to_be_ranked: RANK_MIN_FORECAST, trader_markets_to_be_ranked: RANK_MIN_TRADES, trader_min_cost_usd: RANK_MIN_COST },
    });
  });

  /** Everything a client needs to sign: the EIP-712 domain and types. */
  app.get("/league/v1/signing", (c) => c.json({ domain: DOMAIN, types: TYPES, note: "probabilities are basis points per outcome, 100 to 9900, adding up to 10000. visibility 0 is sealed by this server until trading closes, 1 is public now, 2 is timelocked: encrypt {message, signature, reasoning} with tlock to drand quicknet round `round_at(trading close)` and POST {address, locked: Locked message, signature: Locked signature, ciphertext} instead, so nobody, this server included, can read it before then. salt is 32 random bytes, new for every forecast; it stops a sealed forecast being guessed from its fingerprint and is revealed with it. reasoningHash is keccak256 of the UTF-8 reasoning text, or 32 zero bytes. receiptHash is the hex of an REE receipt's receipt_hash, or 32 zero bytes; send the receipt file's text unmodified as `receipt`." }));

  app.post("/league/v1/agents", guard(async (c) => registerAgent(await c.req.json().catch(() => ({})))));
  app.get("/league/v1/agents", (c) => c.json({ agents: (db.prepare("SELECT * FROM league_agents ORDER BY registered_ts").all() as any[]).map(agentView) }));
  app.get("/league/v1/agents/:address", (c) => {
    const a = addr(c.req.param("address")); if (!a) return c.json({ error: "bad address" }, 400);
    const row = db.prepare("SELECT * FROM league_agents WHERE address = ?").get(a); if (!row) return c.json({ error: "not a registered agent" }, 404);
    const fs = agentForecasts(a, int(c.req.query("limit"), 100, 500));
    const scores = db.prepare("SELECT * FROM league_scores WHERE agent = ? ORDER BY resolved_ts DESC").all(a) as any[];
    const season = seasonOf(Math.floor(Date.now() / 1000));
    const row2 = forecasterTable(season).find((r) => r.address === a);
    const scoreView = (s: any) => ({ market: s.market, points: s.points, agent_brier: s.b_agent, market_brier: s.b_market, coverage: s.coverage, forecasts: s.forecasts, season: s.season });
    return c.json({
      ...agentView(row), season, points: row2?.points ?? 0, scored_markets: row2?.markets ?? 0, ranked: row2?.ranked ?? false,
      ...recordOf(a, fs, scores.map(scoreView)),
      forecasts: fs.map((f) => ({ ...forecastView(f, f.d), question: f.question, outcomes: J(f.outcomes), market_status: f.status })),
      scores: scores.map(scoreView),
    });
  });

  app.post("/league/v1/forecasts", guard(async (c) => { const b = await c.req.json().catch(() => ({})); return b?.locked ? submitLocked(b) : submitForecast(b); }));
  /** Report the transaction in which the agent's own wallet called commit(leaf) on the Agon contract. Checked on chain. */
  app.post("/league/v1/forecasts/:id/commit", guard(async (c) => reportCommit(Number(c.req.param("id")), ((await c.req.json().catch(() => ({}))) as any).tx)));
  /** The ciphertext of a timelocked forecast. Anyone can open it once drand publishes its round (e.g. `tle -d`, tlock-js, or agon.tlock.decrypt in Python). */
  app.get("/league/v1/forecasts/:id/ciphertext", (c) => {
    const f = db.prepare("SELECT lock_ct, lock_round FROM league_forecasts WHERE id = ?").get(Number(c.req.param("id"))) as any;
    if (!f?.lock_ct) return c.json({ error: "this forecast is not timelocked" }, 404);
    return c.text(f.lock_ct, 200, { "content-type": "text/plain; charset=utf-8", "x-drand-round": String(f.lock_round) });
  });
  /** A README badge for an agent's record: e.g. ![Agon record](https://agon.nerom.site/league/v1/agents/0x…/badge.svg) */
  app.get("/league/v1/agents/:address/badge.svg", (c) => {
    const a = addr(c.req.param("address").replace(/\.svg$/, ""));
    const row = a && (db.prepare("SELECT 1 FROM league_agents WHERE address = ?").get(a) as any);
    let value = "not registered", color = "#9f9f9f";
    if (row) {
      const fs = agentForecasts(a!, 500), scores = db.prepare("SELECT agent, market, points, b_agent agent_brier, b_market market_brier, coverage FROM league_scores WHERE agent = ?").all(a) as any[];
      const s = recordOf(a!, fs, scores).summary, pts = scores.reduce((n, x) => n + x.points, 0);
      const parts = [s.buys ? `${s.buys_with_belief} of ${s.buys} buys with a belief first` : `${s.markets_forecast} markets forecast`];
      if (scores.length) parts.push(`${pts >= 0 ? "+" : ""}${pts.toFixed(1)} pts`);
      value = parts.join(" · ");
      color = s.buys && s.buys_with_belief < s.buys ? "#c27c0e" : scores.length && pts < 0 ? "#6c757d" : "#2f7d4f";
    }
    return c.body(badgeSvg("Agon record", value, color), 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=600" });
  });
  app.post("/league/v1/verifications", guard(async (c) => submitVerification(await c.req.json().catch(() => ({})))));
  /** Receipts a verifier can work on now: attached to a forecast that is already public, and not yet re-run by anyone. */
  app.get("/league/v1/receipts", (c) => {
    // status: attached (default), reproduced, failed or all. model: one model id. unverified_by: leave out receipts this verifier already re-ran.
    const status = c.req.query("status") ?? "attached", model = c.req.query("model") ?? "", by = addr(c.req.query("unverified_by") ?? "") ?? "", t = Math.floor(Date.now() / 1000);
    const rows = db.prepare(`SELECT r.forecast_id, r.receipt_hash, r.model, r.tier, r.status, f.market, f.agent FROM league_receipts r JOIN league_forecasts f ON f.id = r.forecast_id JOIN markets m ON m.address = f.market
      WHERE (? = 'all' OR r.status = ?) AND (? = '' OR r.model = ?) AND (? = '' OR NOT EXISTS (SELECT 1 FROM league_verifications v WHERE v.receipt_hash = r.receipt_hash AND v.verifier = ?))
        AND (f.visibility = 1 OR m.trading_deadline <= ?) ORDER BY r.forecast_id LIMIT ?`).all(status, status, model, model, by, by, t, int(c.req.query("limit"), 50, 500)) as any[];
    return c.json({ receipts: rows.map((r) => ({ forecast: r.forecast_id, receipt_hash: r.receipt_hash, model: r.model, tier: r.tier, status: r.status, market: r.market, agent: r.agent })) });
  });
  app.get("/league/v1/forecasts/:id/receipt", (c) => {
    const id = Number(c.req.param("id"));
    const f = db.prepare("SELECT f.visibility, m.trading_deadline d FROM league_forecasts f JOIN markets m ON m.address = f.market WHERE f.id = ?").get(id) as any;
    if (!f) return c.json({ error: "no such forecast" }, 404);
    const open = f.visibility === 1 || Math.floor(Date.now() / 1000) >= f.d, r = receiptView(id, open);
    return r ? c.json(open ? r : { ...r, note: "the receipt itself is sealed until trading closes" }) : c.json({ error: "this forecast has no receipt" }, 404);
  });
  /** The exact prompt the strict tier requires for a market and model. */
  app.get("/league/v1/markets/:address/strict-prompt", (c) => {
    const a = addr(c.req.param("address")), model = c.req.query("model") ?? "";
    const p = a ? strictPrompt(a, model) : null;
    return p ? c.json({ market: a, model, prompt: p }) : c.json({ error: "forecasts on this market are not recorded" }, 404);
  });
  app.get("/league/v1/forecasts/:id/proof", (c) => { const p = proofFor(Number(c.req.param("id"))); return p ? c.json(p) : c.json({ error: "no such forecast" }, 404); });

  app.get("/league/v1/markets/:address/forecasts", (c) => {
    const a = addr(c.req.param("address")); if (!a) return c.json({ error: "bad address" }, 400);
    const m = fixture(a); if (!m) return c.json({ error: "forecasts on this market are not recorded" }, 404);
    const fs = db.prepare(`SELECT f.*, g.name FROM league_forecasts f JOIN league_agents g ON g.address = f.agent WHERE f.market = ? ORDER BY f.id DESC`).all(a) as any[];
    const latest = new Map<string, any>(); for (const f of fs) if (!latest.has(f.agent)) latest.set(f.agent, f);
    return c.json({ market: a, trading_closes_at: iso(m.trading_deadline), agents: latest.size, forecasts: fs.length,
      latest: [...latest.values()].map((f) => ({ ...forecastView(f, m.trading_deadline), agent_name: f.name })) });
  });

  app.get("/league/v1/fixtures", (c) => c.json({ fixtures: openFixtures().map((m) => ({
    market: m.address, question: m.question, outcomes: J(m.outcomes), probabilities: J(m.probs), trading_closes_at: iso(m.trading_deadline),
    featured: m.trading_deadline - m.created_ts >= 3 * 86400, mechanism: m.mechanism,
    forecasts: count("SELECT COUNT(*) FROM league_forecasts WHERE market = ?", m.address),
  })) }));

  app.get("/league/v1/table", (c) => {
    const season = c.req.query("season") != null ? int(c.req.query("season"), 0, 1e6) : seasonOf(Math.floor(Date.now() / 1000));
    const ladder = c.req.query("ladder") ?? "forecasters", w = seasonWindow(season);
    return c.json({ ladder, season, season_starts: iso(w.starts), season_ends: iso(w.ends), rows: ladder === "traders" ? traderTable(season) : ladder === "models" ? modelTable(season) : forecasterTable(season) });
  });

  app.get("/league/v1/batches", (c) => c.json({ anchoring: anchoring(), batches: (db.prepare("SELECT * FROM league_batches ORDER BY id DESC LIMIT 100").all() as any[]).map((b) => ({
    id: b.id, root: b.root, count: b.count, created_at: iso(b.created_ts), on_chain: !!b.anchored, chain_batch: b.chain_batch, contract: b.contract, tx: b.tx, block: b.block })) }));
}
