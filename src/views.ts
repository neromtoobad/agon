import { db } from "./db.ts";
import { network } from "./config.ts";

const J = (s: string | null) => (s ? JSON.parse(s) : null);
const iso = (t: number | null) => (t ? new Date(t * 1000).toISOString() : null);

/** Delphi's app addresses a market by the UUID at the end of its metadata file name. */
export function appUrl(uri: string | null): string | null {
  const m = uri ? decodeURIComponent(uri).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i) : null;
  return m ? `${network.appUrl}/market/${m[1]}` : null;
}

export function marketView(m: any, full = false) {
  const outcomes: string[] | null = J(m.outcomes), probs: number[] | null = J(m.probs);
  const v: any = {
    address: m.address, question: m.question, outcomes, probabilities: probs, status: m.status, mechanism: m.mechanism,
    winning_outcome: m.winning_outcome, winning_label: m.winning_outcome != null && outcomes ? outcomes[m.winning_outcome] ?? null : null,
    volume_usd: m.volume, trades: m.n_trades, traders: m.n_traders,
    created_at: iso(m.created_ts), trading_closes_at: iso(m.trading_deadline), settlement_deadline: iso(m.settlement_deadline),
    resolved_at: iso(m.resolved_ts), last_trade_at: iso(m.last_trade_ts), creator: m.creator, app_url: appUrl(m.metadata_uri),
  };
  if (full) Object.assign(v, {
    gateway: m.gateway, factory: m.factory, implementation: m.implementation, created_block: m.created_block, created_tx: m.created_tx,
    liquidity_param: m.liquidity_param, trading_fee: m.trading_fee, earliest_resolve_at: iso(m.earliest_resolve),
    resolution_requested_at: iso(m.resolution_requested_ts), resolved_tx: m.resolved_tx,
    settlement_criteria: m.criteria, data_sources: J(m.data_sources), judge_model: m.judge_model, category: m.category,
    metadata: { uri: m.metadata_uri, sha256_onchain: m.metadata_hash, matches_chain: m.metadata_verified === 1 ? true : m.metadata_verified === 0 ? false : null },
  });
  return v;
}

export function eventView(e: any, outcomes?: string[] | null) {
  const usd = e.tokens ? Number(e.tokens) / 1e6 : null, shares = e.shares ? Number(e.shares) / 1e18 : null;
  return {
    kind: e.kind, market: e.market, wallet: e.wallet, outcome: e.outcome_idx, outcome_label: e.outcome_idx != null && outcomes ? outcomes[e.outcome_idx] ?? null : undefined,
    usd, shares, price: usd && shares && (e.kind === "buy" || e.kind === "sell") ? Math.round((usd / shares) * 1e6) / 1e6 : undefined,
    block: e.block, log_index: e.log_index, at: iso(e.ts), tx: e.tx,
  };
}

/** Probability of the eventual winner at a point in time, from the replayed price path. */
const qAt = db.prepare("SELECT probs FROM prices WHERE market=? AND ts<=? ORDER BY block DESC, log_index DESC LIMIT 1");
export function probsAt(market: string, ts: number): number[] | null {
  const r = qAt.get(market, ts) as any;
  return r ? JSON.parse(r.probs) : null;
}

export { iso, J };
