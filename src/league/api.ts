import type { Hono } from "hono";
import { db } from "../db.ts";
import { lc } from "../config.ts";
import { J } from "../views.ts";
import {
  DOMAIN, TYPES, Refused, registerAgent, submitForecast, agentView, forecastView, proofFor, openFixtures, fixture,
  forecasterTable, traderTable, seasonOf, seasonWindow, RANK_MIN_FORECAST, RANK_MIN_TRADES, RANK_MIN_COST, MIN_FIXTURE_SECONDS,
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
  app.get("/league/v1/signing", (c) => c.json({ domain: DOMAIN, types: TYPES, note: "probabilities are basis points per outcome, 100 to 9900, adding up to 10000. visibility 0 is sealed until trading closes, 1 is public now. reasoningHash is keccak256 of the UTF-8 reasoning text, or 32 zero bytes." }));

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
    return c.json({ ladder, season, season_starts: iso(w.starts), season_ends: iso(w.ends), rows: ladder === "traders" ? traderTable(season) : forecasterTable(season) });
  });

  app.get("/league/v1/batches", (c) => c.json({ anchoring: anchoring(), batches: (db.prepare("SELECT * FROM league_batches ORDER BY id DESC LIMIT 100").all() as any[]).map((b) => ({
    id: b.id, root: b.root, count: b.count, created_at: iso(b.created_ts), on_chain: !!b.anchored, chain_batch: b.chain_batch, contract: b.contract, tx: b.tx, block: b.block })) }));
}
