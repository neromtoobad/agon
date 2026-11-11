import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db.ts";
import { ROOT } from "./config.ts";
import { appUrl, probsAt, iso, J } from "./views.ts";

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/**
 * One record per market that settled with a winner: the question as traders saw it, the rules and
 * sources fixed before trading, what the market believed at several horizons, and what happened.
 * This is the shape a forecasting model needs for training or evaluation.
 */
export function resolvedRecords(opts: { path?: boolean } = {}) {
  const rows = db.prepare("SELECT * FROM markets WHERE status='settled' AND winning_outcome IS NOT NULL AND question IS NOT NULL ORDER BY resolved_ts").all() as any[];
  const qPath = db.prepare("SELECT ts, probs FROM prices WHERE market=? ORDER BY block, log_index");
  return rows.map((m) => {
    const outcomes: string[] = J(m.outcomes) ?? [], w: number = m.winning_outcome, n = m.outcome_count ?? outcomes.length;
    const final: number[] | null = J(m.close_probs);
    const at = (secondsBeforeClose: number) => {
      if (!m.trading_deadline) return null;
      const t = m.trading_deadline - secondsBeforeClose;
      if (m.created_ts && t < m.created_ts) return null; // market did not exist yet
      const p = probsAt(m.address, t) ?? Array(n).fill(1 / n);
      return r4(p[w]);
    };
    const brier = final ? r4(final.reduce((a, p, j) => a + (p - (j === w ? 1 : 0)) ** 2, 0)) : null;
    const rec: any = {
      market: m.address, mechanism: m.mechanism, question: m.question, outcomes, settlement_criteria: m.criteria, data_sources: J(m.data_sources) ?? [],
      judge_model: m.judge_model, created_at: iso(m.created_ts), trading_closed_at: iso(m.trading_deadline), resolved_at: iso(m.resolved_ts),
      winning_outcome: w, winning_label: outcomes[w] ?? null,
      final_probabilities: final, p_winner_final: final ? r4(final[w]) : null, p_winner_24h_before_close: at(86400), p_winner_1h_before_close: at(3600),
      brier_final: brier, volume_usd: m.volume, trades: m.n_trades, traders: m.n_traders,
      text_matches_chain: m.metadata_verified === 1, resolved_tx: m.resolved_tx, app_url: appUrl(m.metadata_uri),
    };
    if (opts.path) rec.price_path = (qPath.all(m.address) as any[]).map((p) => [p.ts, ...JSON.parse(p.probs).map(r4)]);
    return rec;
  });
}

const csvCell = (v: unknown) => {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(rows: any[]) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}
export const toJsonl = (rows: any[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

export async function exportDataset(dir?: string) {
  const out = dir ?? join(ROOT, "data", "export");
  mkdirSync(out, { recursive: true });
  const withPath = resolvedRecords({ path: true }), flat = resolvedRecords();
  writeFileSync(join(out, "resolved_markets.jsonl"), toJsonl(withPath));
  writeFileSync(join(out, "resolved_markets.csv"), toCsv(flat));
  const trades = db.prepare("SELECT block, log_index, ts, tx, market, kind, wallet, outcome_idx, tokens, shares FROM events WHERE kind IN ('buy','sell','redeem','liquidate') ORDER BY block, log_index").all();
  writeFileSync(join(out, "trades.csv"), toCsv(trades as any[]));
  const scored = flat.filter((r) => r.brier_final != null);
  const mean = (k: string) => { const v = flat.map((r) => r[k]).filter((x) => x != null); return v.length ? r4(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const summary = { generated_at: new Date().toISOString(), resolved_markets: flat.length, trades: trades.length,
    mean_brier_final: mean("brier_final"), mean_p_winner_final: mean("p_winner_final"), mean_p_winner_24h_before_close: mean("p_winner_24h_before_close"),
    text_verified_against_chain: flat.filter((r) => r.text_matches_chain).length, scored: scored.length };
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`wrote ${flat.length} resolved markets and ${trades.length} trades to ${out}`);
  console.log(JSON.stringify(summary));
}
