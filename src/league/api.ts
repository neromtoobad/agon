import type { Hono } from "hono";
import { db } from "../db.ts";
import { lc } from "../config.ts";
import { J } from "../views.ts";
import {
  DOMAIN, TYPES, Refused, registerAgent, submitForecast, agentView, forecastView, proofFor, openFixtures, fixture,
  forecasterTable, traderTable, modelTable, submitVerification, strictPrompt, receiptView, seasonOf, seasonWindow, RANK_MIN_FORECAST, RANK_MIN_TRADES, RANK_MIN_COST, MIN_FIXTURE_SECONDS,
} from "./core.ts";
import { anchoring } from "./anchor.ts";

const iso = (t: number | null) => (t ? new Date(t * 1000).toISOString() : null);
const addr = (s: string) => (/^0x[0-9a-fA-F]{40}$/.test(s) ? lc(s) : null);
const int = (v: string | undefined, d: number, max: number) => Math.min(Math.max(Number.isFinite(Number(v)) ? Number(v) : d, 0), max);
const count = (q: string, ...a: any[]) => Object.values(db.prepare(q).get(...a) as any)[0] as number;

export function mountLeague(app: Hono) {
  const guard = (fn: (c: any) => Promise<any>) => async (c: any) => {
    try { return c.json(await fn(c)); }
    catch (e) { if (e instanceof Refused) return c.json({ error: e.message }, 400); throw e; }
  };

  app.get("/league/v1/status", (c) => {
    const s = seasonOf(Math.floor(Date.now() / 1000)), w = seasonWindow(s);
    const batches = db.prepare("SELECT COUNT(*) n, SUM(anchored) a FROM league_batches").get() as any;
    return c.json({
      season: s, season_starts: iso(w.starts), season_ends: iso(w.ends),
      agents: count("SELECT COUNT(*) FROM league_agents"), forecasts: count("SELECT COUNT(*) FROM league_forecasts"),
      sealed_now: count("SELECT COUNT(*) FROM league_forecasts f JOIN markets m ON m.address = f.market WHERE f.visibility = 0 AND m.trading_deadline > ?", Math.floor(Date.now() / 1000)),
      scored_markets: count("SELECT COUNT(DISTINCT market) FROM league_scores"), open_fixtures: openFixtures().length,
      batches: batches.n, batches_on_chain: batches.a ?? 0, waiting_for_batch: count("SELECT COUNT(*) FROM league_forecasts WHERE batch IS NULL"),
      anchoring: anchoring(),
      rules: { fixture_min_hours_open: MIN_FIXTURE_SECONDS / 3600, markets_to_be_ranked: RANK_MIN_FORECAST, trader_markets_to_be_ranked: RANK_MIN_TRADES, trader_min_cost_usd: RANK_MIN_COST },
    });
  });

  /** Everything a client needs to sign: the EIP-712 domain and types. */
  app.get("/league/v1/signing", (c) => c.json({ domain: DOMAIN, types: TYPES, note: "probabilities are basis points per outcome, 100 to 9900, adding up to 10000. visibility 0 is sealed until trading closes, 1 is public now. reasoningHash is keccak256 of the UTF-8 reasoning text, or 32 zero bytes. receiptHash is the hex of an REE receipt's receipt_hash, or 32 zero bytes; send the receipt file's text unmodified as `receipt`." }));

  app.post("/league/v1/agents", guard(async (c) => registerAgent(await c.req.json().catch(() => ({})))));
  app.get("/league/v1/agents", (c) => c.json({ agents: (db.prepare("SELECT * FROM league_agents ORDER BY registered_ts").all() as any[]).map(agentView) }));
  app.get("/league/v1/agents/:address", (c) => {
    const a = addr(c.req.param("address")); if (!a) return c.json({ error: "bad address" }, 400);
    const row = db.prepare("SELECT * FROM league_agents WHERE address = ?").get(a); if (!row) return c.json({ error: "not a registered agent" }, 404);
    const fs = db.prepare(`SELECT f.*, m.trading_deadline d, m.question, m.outcomes, m.status, m.winning_outcome FROM league_forecasts f JOIN markets m ON m.address = f.market WHERE f.agent = ? ORDER BY f.id DESC LIMIT ?`).all(a, int(c.req.query("limit"), 100, 500)) as any[];
    const scores = db.prepare("SELECT * FROM league_scores WHERE agent = ? ORDER BY resolved_ts DESC").all(a) as any[];
    const season = seasonOf(Math.floor(Date.now() / 1000));
    const row2 = forecasterTable(season).find((r) => r.address === a);
    return c.json({
      ...agentView(row), season, points: row2?.points ?? 0, scored_markets: row2?.markets ?? 0, ranked: row2?.ranked ?? false,
      forecasts: fs.map((f) => ({ ...forecastView(f, f.d), question: f.question, outcomes: J(f.outcomes), market_status: f.status })),
      scores: scores.map((s) => ({ market: s.market, points: s.points, agent_brier: s.b_agent, market_brier: s.b_market, coverage: s.coverage, forecasts: s.forecasts, season: s.season })),
    });
  });

  app.post("/league/v1/forecasts", guard(async (c) => submitForecast(await c.req.json().catch(() => ({})))));
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
    return p ? c.json({ market: a, model, prompt: p }) : c.json({ error: "not a league fixture" }, 404);
  });
  app.get("/league/v1/forecasts/:id/proof", (c) => { const p = proofFor(Number(c.req.param("id"))); return p ? c.json(p) : c.json({ error: "no such forecast" }, 404); });

  app.get("/league/v1/markets/:address/forecasts", (c) => {
    const a = addr(c.req.param("address")); if (!a) return c.json({ error: "bad address" }, 400);
    const m = fixture(a); if (!m) return c.json({ error: "not a league fixture" }, 404);
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
