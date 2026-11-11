import { db, tx, getMeta, setMeta } from "./db.ts";

const SCHEMA = "3";
const DDL = `
CREATE TABLE IF NOT EXISTS prices (
  market TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL, ts INTEGER, probs TEXT NOT NULL,
  PRIMARY KEY (market, block, log_index)
);
CREATE TABLE IF NOT EXISTS positions (
  market TEXT NOT NULL, wallet TEXT NOT NULL, outcome_idx INTEGER NOT NULL,
  shares REAL NOT NULL, bought_shares REAL NOT NULL, cost REAL NOT NULL, sold_shares REAL NOT NULL, sale_proceeds REAL NOT NULL,
  PRIMARY KEY (market, wallet, outcome_idx)
);
CREATE INDEX IF NOT EXISTS positions_wallet ON positions(wallet);
CREATE TABLE IF NOT EXISTS wallet_markets (
  market TEXT NOT NULL, wallet TEXT NOT NULL,
  cost REAL NOT NULL, sale_proceeds REAL NOT NULL, redeemed REAL NOT NULL, liquidated REAL NOT NULL,
  n_trades INTEGER NOT NULL, first_ts INTEGER, last_ts INTEGER,
  main_outcome INTEGER, revealed_prob REAL, closed INTEGER NOT NULL, resolved INTEGER NOT NULL, won INTEGER,
  brier REAL, unredeemed_est REAL NOT NULL, pnl REAL,
  PRIMARY KEY (market, wallet)
);
CREATE INDEX IF NOT EXISTS wm_wallet ON wallet_markets(wallet);
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY, first_ts INTEGER, last_ts INTEGER, n_trades INTEGER, n_markets INTEGER,
  volume REAL, open_cost REAL, closed_markets INTEGER, closed_cost REAL, realized_pnl REAL, roi REAL,
  resolved_markets INTEGER, hits INTEGER, hit_rate REAL, brier REAL, markets_created INTEGER
);`;

export function ensureDerived() {
  if (getMeta("derived_schema") !== SCHEMA) {
    db.exec("DROP TABLE IF EXISTS prices; DROP TABLE IF EXISTS positions; DROP TABLE IF EXISTS wallet_markets; DROP TABLE IF EXISTS wallets;");
    setMeta("derived_schema", SCHEMA);
    setMeta("derived_full", "0");
  }
  db.exec(DDL);
}
ensureDerived();

const USDC = 1e6, SHARE = 1e18;
const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

interface Pos { shares: number; bought: number; cost: number; sold: number; proceeds: number }
interface WM { cost: number; sale: number; redeemed: number; redeemedShares: number; liquidated: number; n: number; first: number | null; last: number | null; byOutcome: Map<number, Pos>; buys: { o: number; cost: number; p: number }[] }

function statusOf(m: any, settled: boolean, failed: boolean, now: number): string {
  if (settled) return "settled";
  if (failed) return "failed";
  if (m.trading_deadline && now < m.trading_deadline) return "open";
  if (m.settlement_deadline && now < m.settlement_deadline) return "awaiting_settlement";
  return m.trading_deadline ? "expired" : "open";
}

const qEvents = db.prepare("SELECT * FROM events WHERE market=? AND emitter=? AND kind!='market_created' ORDER BY block, log_index");
const insPrice = db.prepare("INSERT INTO prices(market,block,log_index,ts,probs) VALUES(?,?,?,?,?)");
const insPos = db.prepare("INSERT INTO positions VALUES(?,?,?,?,?,?,?,?)");
const insWM = db.prepare("INSERT INTO wallet_markets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
const upMarket = db.prepare(`UPDATE markets SET status=?, winning_outcome=?, resolved_ts=?, resolved_tx=?, resolution_requested_ts=?, probs=?, close_probs=?,
  volume=?, n_trades=?, n_traders=?, first_trade_ts=?, last_trade_ts=? WHERE address=?`);

/**
 * Rebuild everything Tripod knows about one market from its raw events.
 *
 * Probabilities are replayed, not sampled:
 *  - LMSR events carry exp(q_i/b) for the traded outcome and the new sum, so p_i = exp/sum exactly;
 *    the other outcomes keep their ratios to each other.
 *  - Pari-mutuel markets price by supply: p_i = s_i^2 / sum(s_j^2), starting from the creator's equal seed shares.
 */
export function deriveMarket(address: string, now = Math.floor(Date.now() / 1000)) {
  const m = db.prepare("SELECT * FROM markets WHERE address=?").get(address) as any;
  if (!m || !m.gateway) return;
  const n: number = m.outcome_count ?? 2;
  const evs = qEvents.all(address, m.gateway) as any[];

  let probs = Array(n).fill(1 / n);
  const supply = Array(n).fill(m.init_shares ? Number(m.init_shares) / SHARE : 0);
  const wms = new Map<string, WM>();
  const wm = (w: string): WM => {
    let x = wms.get(w);
    if (!x) wms.set(w, (x = { cost: 0, sale: 0, redeemed: 0, redeemedShares: 0, liquidated: 0, n: 0, first: null, last: null, byOutcome: new Map(), buys: [] }));
    return x;
  };
  const pos = (x: WM, o: number): Pos => {
    let p = x.byOutcome.get(o);
    if (!p) x.byOutcome.set(o, (p = { shares: 0, bought: 0, cost: 0, sold: 0, proceeds: 0 }));
    return p;
  };

  let winner: number | null = null, resolvedTs: number | null = null, resolvedTx: string | null = null, requestedTs: number | null = null, failed = false;
  let volume = 0, nTrades = 0, firstTrade: number | null = null, lastTrade: number | null = null;
  let redeemTokens = 0, redeemShares = 0;
  const priceRows: [number, number, number | null, string][] = [];

  for (const e of evs) {
    const tokens = e.tokens ? Number(e.tokens) / USDC : 0;
    const shares = e.shares ? Number(e.shares) / SHARE : 0;
    if (e.kind === "buy" || e.kind === "sell") {
      const i: number = e.outcome_idx, buy = e.kind === "buy";
      if (m.mechanism === "lmsr" && e.extra) {
        const x = JSON.parse(e.extra);
        const pi = Number(BigInt(x.exp) * 1000000000000n / BigInt(x.expSum)) / 1e12;
        const rest = 1 - probs[i];
        probs = probs.map((p, j) => (j === i ? pi : rest > 0 ? (p * (1 - pi)) / rest : (1 - pi) / (n - 1)));
      } else {
        supply[i] += buy ? shares : -shares;
        const sum = supply.reduce((a, s) => a + s * s, 0);
        if (sum > 0) probs = supply.map((s) => (s * s) / sum);
      }
      priceRows.push([e.block, e.log_index, e.ts, JSON.stringify(probs.map((p) => round(p)))]);
      const x = wm(e.wallet), p = pos(x, i);
      if (buy) { p.shares += shares; p.bought += shares; p.cost += tokens; x.cost += tokens; x.buys.push({ o: i, cost: tokens, p: probs[i] }); }
      else { p.shares -= shares; p.sold += shares; p.proceeds += tokens; x.sale += tokens; }
      x.n++; x.first ??= e.ts; x.last = e.ts;
      volume += tokens; nTrades++; firstTrade ??= e.ts; lastTrade = e.ts;
    } else if (e.kind === "redeem") {
      const x = wm(e.wallet); x.redeemed += tokens; x.redeemedShares += shares; redeemTokens += tokens; redeemShares += shares;
    } else if (e.kind === "liquidate") {
      const x = wm(e.wallet); x.liquidated += tokens;
      const ex = e.extra ? JSON.parse(e.extra) : null;
      ex?.outcomeIndices.forEach((o: number, k: number) => { pos(x, o).shares -= Number(ex.sharesIn[k]) / SHARE; });
    } else if (e.kind === "settled") { winner = e.outcome_idx; resolvedTs = e.ts; resolvedTx = e.tx; }
    else if (e.kind === "failed") { failed = true; resolvedTs = e.ts; resolvedTx = e.tx; }
    else if (e.kind === "resolution_requested") requestedTs = e.ts;
  }

  const status = statusOf(m, winner !== null, failed, now);
  const closed = status === "settled" || status === "failed" || status === "expired";
  // What one winning share paid in this market: $1 on LMSR, the observed pool split on pari-mutuel.
  const payout = m.mechanism === "lmsr" ? 1 : redeemShares > 0 ? redeemTokens / redeemShares : 0;

  db.prepare("DELETE FROM prices WHERE market=?").run(address);
  db.prepare("DELETE FROM positions WHERE market=?").run(address);
  db.prepare("DELETE FROM wallet_markets WHERE market=?").run(address);
  for (const r of priceRows) insPrice.run(address, r[0], r[1], r[2], r[3]);

  for (const [w, x] of wms) {
    let main: number | null = null, mainCost = -1;
    for (const [o, p] of x.byOutcome) {
      insPos.run(address, w, o, round(Math.max(p.shares, 0)), round(p.bought), round(p.cost), round(p.sold), round(p.proceeds));
      if (p.cost > mainCost) { mainCost = p.cost; main = o; }
    }
    const mainBuys = x.buys.filter((b) => b.o === main);
    const revealed = mainCost > 0 ? mainBuys.reduce((a, b) => a + b.cost * b.p, 0) / mainCost : null;
    const resolved = winner !== null;
    let unredeemed = 0, brier: number | null = null, won: number | null = null;
    if (resolved) {
      const held = Math.max((x.byOutcome.get(winner!)?.shares ?? 0) - x.redeemedShares, 0);
      unredeemed = held * payout;
      won = main === winner ? 1 : 0;
      if (x.cost > 0) brier = x.buys.reduce((a, b) => a + b.cost * (b.p - (b.o === winner ? 1 : 0)) ** 2, 0) / x.cost;
    }
    const pnl = closed ? x.sale + x.redeemed + x.liquidated + unredeemed - x.cost : null;
    insWM.run(address, w, round(x.cost), round(x.sale), round(x.redeemed), round(x.liquidated), x.n, x.first, x.last, main,
      revealed === null ? null : round(revealed), closed ? 1 : 0, resolved ? 1 : 0, won, brier === null ? null : round(brier), round(unredeemed), pnl === null ? null : round(pnl));
  }

  const p = JSON.stringify(probs.map((x) => round(x)));
  upMarket.run(status, winner, resolvedTs, resolvedTx, requestedTs, p, p, round(volume), nTrades, wms.size, firstTrade, lastTrade, address);
}

export function deriveWallets() {
  db.exec("DELETE FROM wallets");
  db.exec(`
    INSERT INTO wallets(address, first_ts, last_ts, n_trades, n_markets, volume, open_cost, closed_markets, closed_cost, realized_pnl, roi, resolved_markets, hits, hit_rate, brier, markets_created)
    SELECT wallet, MIN(first_ts), MAX(last_ts), SUM(n_trades), COUNT(*),
      ROUND(SUM(cost + sale_proceeds), 6),
      ROUND(SUM(CASE WHEN closed=0 THEN cost - sale_proceeds ELSE 0 END), 6),
      SUM(closed), ROUND(SUM(CASE WHEN closed=1 THEN cost ELSE 0 END), 6),
      ROUND(SUM(CASE WHEN closed=1 THEN pnl ELSE 0 END), 6),
      CASE WHEN SUM(CASE WHEN closed=1 THEN cost ELSE 0 END) > 0 THEN ROUND(SUM(CASE WHEN closed=1 THEN pnl ELSE 0 END) / SUM(CASE WHEN closed=1 THEN cost ELSE 0 END), 6) END,
      SUM(resolved), SUM(COALESCE(won, 0)),
      CASE WHEN SUM(resolved) > 0 THEN ROUND(1.0 * SUM(COALESCE(won, 0)) / SUM(resolved), 6) END,
      CASE WHEN SUM(CASE WHEN brier IS NOT NULL THEN cost ELSE 0 END) > 0 THEN ROUND(SUM(CASE WHEN brier IS NOT NULL THEN brier * cost ELSE 0 END) / SUM(CASE WHEN brier IS NOT NULL THEN cost ELSE 0 END), 6) END,
      0
    FROM wallet_markets GROUP BY wallet;
    INSERT INTO wallets(address, markets_created) SELECT creator, COUNT(*) FROM markets WHERE creator IS NOT NULL GROUP BY creator
      ON CONFLICT(address) DO UPDATE SET markets_created=excluded.markets_created;
  `);
}

/** Recompute the given markets (or all of them) and every wallet aggregate. */
export function derive(markets?: Iterable<string>) {
  const full = !markets || getMeta("derived_full") !== "1";
  const list = full ? (db.prepare("SELECT address FROM markets").all() as any[]).map((r) => r.address) : [...new Set(markets)];
  const now = Math.floor(Date.now() / 1000);
  tx(() => { for (const a of list) deriveMarket(a, now); deriveWallets(); });
  if (full) setMeta("derived_full", "1");
  return list.length;
}

/** Markets whose status depends on the clock (open → awaiting → expired) need a refresh even with no new events. */
export function dueForClock(): string[] {
  const now = Math.floor(Date.now() / 1000);
  return (db.prepare(`SELECT address FROM markets WHERE (status='open' AND trading_deadline <= ?) OR (status='awaiting_settlement' AND settlement_deadline <= ?)`).all(now, now) as any[]).map((r) => r.address);
}
