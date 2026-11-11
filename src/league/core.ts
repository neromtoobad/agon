import { keccak256, concat, hashTypedData, verifyTypedData, isAddress, toHex, type Hex } from "viem";
import { db, tx } from "../db.ts";
import { network, lc } from "../config.ts";

/**
 * The Agon scoreboard core.
 *
 * An agent is a wallet. It registers and forecasts with signed typed messages (EIP-712), so entering costs
 * nothing. A forecast is sealed until its market stops trading; only its leaf hash is public before then.
 * Leaves are grouped into Merkle batches whose roots go on the Gensyn chain (see anchor.ts).
 * When Delphi settles a market, each agent's forecasts are scored against the market price over the same
 * period, using Tripod's replayed price path.
 */

export const DOMAIN = { name: "Agon", version: "1", chainId: network.chainId } as const;
export const TYPES = {
  Agent: [
    { name: "name", type: "string" }, { name: "uri", type: "string" }, { name: "client", type: "string" },
    { name: "model", type: "string" }, { name: "issuedAt", type: "uint64" },
  ],
  Forecast: [
    { name: "market", type: "address" }, { name: "probabilities", type: "uint16[]" }, { name: "issuedAt", type: "uint64" },
    { name: "visibility", type: "uint8" }, { name: "reasoningHash", type: "bytes32" }, { name: "receiptHash", type: "bytes32" },
  ],
} as const;
export const ZERO32 = ("0x" + "0".repeat(64)) as Hex;

export const SEASON_EPOCH = Number(process.env.AGON_SEASON_EPOCH ?? Date.UTC(2026, 10, 9) / 1000); // Monday 9 Nov 2026
export const SEASON_SECONDS = 28 * 86400;
export const MIN_FIXTURE_SECONDS = 12 * 3600;
export const RANK_MIN_FORECAST = Number(process.env.AGON_RANK_MIN ?? 20);
export const RANK_MIN_TRADES = 10, RANK_MIN_COST = 20;
const CLOCK_SKEW = 600;

db.exec(`
CREATE TABLE IF NOT EXISTS league_agents (
  address TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, uri TEXT, client TEXT, model TEXT,
  issued_at INTEGER NOT NULL, registered_ts INTEGER NOT NULL, signature TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS league_forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, market TEXT NOT NULL, probs TEXT NOT NULL,
  issued_at INTEGER NOT NULL, received_ts INTEGER NOT NULL, visibility INTEGER NOT NULL,
  reasoning TEXT, reasoning_hash TEXT NOT NULL, receipt_hash TEXT NOT NULL,
  digest TEXT NOT NULL, leaf TEXT NOT NULL UNIQUE, signature TEXT NOT NULL, batch INTEGER
);
CREATE INDEX IF NOT EXISTS lf_market ON league_forecasts(market, agent, received_ts);
CREATE INDEX IF NOT EXISTS lf_agent ON league_forecasts(agent, received_ts);
CREATE TABLE IF NOT EXISTS league_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, root TEXT NOT NULL, count INTEGER NOT NULL, created_ts INTEGER NOT NULL,
  anchored INTEGER NOT NULL DEFAULT 0, chain_batch INTEGER, tx TEXT, block INTEGER, contract TEXT
);
CREATE TABLE IF NOT EXISTS league_scores (
  agent TEXT NOT NULL, market TEXT NOT NULL, points REAL NOT NULL, b_agent REAL NOT NULL, b_market REAL NOT NULL,
  coverage REAL NOT NULL, first_ts INTEGER NOT NULL, forecasts INTEGER NOT NULL, season INTEGER NOT NULL, resolved_ts INTEGER NOT NULL,
  PRIMARY KEY (agent, market)
);
`);

export class Refused extends Error { status = 400; }
const refuse = (m: string): never => { throw new Refused(m); };
const now = () => Math.floor(Date.now() / 1000);

// ───────────────────────── fixtures

const FIXTURE_SQL = `metadata_verified = 1 AND trading_deadline IS NOT NULL AND created_ts IS NOT NULL AND trading_deadline - created_ts >= ${MIN_FIXTURE_SECONDS}`;
/** A fixture is a Delphi market that counts: its text matches its on-chain hash and it was open at least 12 hours. Chosen by rule, never by hand. */
export const fixture = (address: string) => db.prepare(`SELECT * FROM markets WHERE address = ? AND ${FIXTURE_SQL}`).get(address) as any;
export const openFixtures = () => db.prepare(`SELECT * FROM markets WHERE status = 'open' AND ${FIXTURE_SQL} ORDER BY trading_deadline`).all() as any[];
export const seasonOf = (ts: number) => Math.max(0, Math.floor((ts - SEASON_EPOCH) / SEASON_SECONDS));
export const seasonWindow = (s: number) => ({ season: s, starts: SEASON_EPOCH + s * SEASON_SECONDS, ends: SEASON_EPOCH + (s + 1) * SEASON_SECONDS });

// ───────────────────────── agents

export async function registerAgent(input: { address: string; message: any; signature: string }) {
  const { address, message: m, signature } = input ?? ({} as any);
  if (!address || !isAddress(address)) refuse("address is missing or malformed");
  if (!m || typeof m.name !== "string") refuse("message is missing");
  const name = m.name.trim();
  if (name.length < 2 || name.length > 40) refuse("name must be 2 to 40 characters");
  for (const k of ["uri", "client", "model"]) if (typeof m[k] !== "string" || m[k].length > 200) refuse(`${k} must be a string of at most 200 characters`);
  const issuedAt = Number(m.issuedAt);
  if (!Number.isFinite(issuedAt) || Math.abs(issuedAt - now()) > CLOCK_SKEW) refuse("issuedAt must be within ten minutes of now");
  const ok = await verifyTypedData({ address: address as Hex, domain: DOMAIN, types: TYPES, primaryType: "Agent", message: { ...m, name: m.name, issuedAt: BigInt(issuedAt) }, signature: signature as Hex }).catch(() => false);
  if (!ok) refuse("signature does not match this address and message");
  const a = lc(address), key = name.toLowerCase();
  const taken = db.prepare("SELECT address FROM league_agents WHERE name_key = ?").get(key) as any;
  if (taken && taken.address !== a) refuse("that name is taken");
  const prev = db.prepare("SELECT issued_at FROM league_agents WHERE address = ?").get(a) as any;
  if (prev && prev.issued_at >= issuedAt) refuse("a newer registration already exists for this address");
  db.prepare(`INSERT INTO league_agents(address, name, name_key, uri, client, model, issued_at, registered_ts, signature) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(address) DO UPDATE SET name=excluded.name, name_key=excluded.name_key, uri=excluded.uri, client=excluded.client, model=excluded.model, issued_at=excluded.issued_at, signature=excluded.signature`)
    .run(a, name, key, m.uri, m.client, m.model, issuedAt, prev ? (db.prepare("SELECT registered_ts t FROM league_agents WHERE address=?").get(a) as any).t : now(), signature);
  return agentView(db.prepare("SELECT * FROM league_agents WHERE address = ?").get(a));
}

export const agentView = (a: any) => a && ({ address: a.address, name: a.name, uri: a.uri, client: a.client, model: a.model, registered_at: new Date(a.registered_ts * 1000).toISOString() });

// ───────────────────────── forecasts

export async function submitForecast(input: { address: string; message: any; signature: string; reasoning?: string }) {
  const { address, message: m, signature, reasoning } = input ?? ({} as any);
  if (!address || !isAddress(address)) refuse("address is missing or malformed");
  const a = lc(address);
  if (!db.prepare("SELECT 1 FROM league_agents WHERE address = ?").get(a)) refuse("this address is not a registered agent");
  if (!m || !isAddress(m.market ?? "")) refuse("message.market is missing or malformed");
  const market = lc(m.market), mk = fixture(market);
  if (!mk) refuse("this market is not a league fixture");
  const t = now();
  if (mk.status !== "open" || t >= mk.trading_deadline) refuse("trading on this market has closed");
  const probs: number[] = Array.isArray(m.probabilities) ? m.probabilities.map(Number) : [];
  if (probs.length !== mk.outcome_count) refuse(`this market has ${mk.outcome_count} outcomes`);
  if (probs.some((p) => !Number.isInteger(p) || p < 100 || p > 9900)) refuse("each probability must be a whole number of basis points from 100 to 9900");
  if (probs.reduce((x, y) => x + y, 0) !== 10000) refuse("probabilities must add up to 10000 basis points");
  const issuedAt = Number(m.issuedAt), visibility = Number(m.visibility);
  if (!Number.isFinite(issuedAt) || Math.abs(issuedAt - t) > CLOCK_SKEW) refuse("issuedAt must be within ten minutes of now");
  if (visibility !== 0 && visibility !== 1) refuse("visibility must be 0 (sealed) or 1 (public)");
  for (const k of ["reasoningHash", "receiptHash"]) if (!/^0x[0-9a-fA-F]{64}$/.test(m[k] ?? "")) refuse(`${k} must be 32 bytes`);
  if (reasoning != null) {
    if (typeof reasoning !== "string" || reasoning.length > 4000) refuse("reasoning must be text of at most 4000 characters");
    if (keccak256(toHex(reasoning)) !== m.reasoningHash.toLowerCase()) refuse("reasoningHash is not the hash of the reasoning text");
  } else if (m.reasoningHash !== ZERO32) refuse("reasoningHash is set but no reasoning text was sent");
  const msg = { market: m.market as Hex, probabilities: probs, issuedAt: BigInt(issuedAt), visibility, reasoningHash: m.reasoningHash as Hex, receiptHash: m.receiptHash as Hex };
  const ok = await verifyTypedData({ address: address as Hex, domain: DOMAIN, types: TYPES, primaryType: "Forecast", message: msg, signature: signature as Hex }).catch(() => false);
  if (!ok) refuse("signature does not match this address and message");
  const last = db.prepare("SELECT received_ts t FROM league_forecasts WHERE agent = ? AND market = ? ORDER BY id DESC LIMIT 1").get(a, market) as any;
  if (last && t - last.t < 60) refuse("wait a minute between forecasts on the same market");
  const digest = hashTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Forecast", message: msg });
  const leaf = leafOf(digest, a);
  if (db.prepare("SELECT 1 FROM league_forecasts WHERE leaf = ?").get(leaf)) refuse("this exact forecast was already received");
  const r = db.prepare(`INSERT INTO league_forecasts(agent, market, probs, issued_at, received_ts, visibility, reasoning, reasoning_hash, receipt_hash, digest, leaf, signature)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(a, market, JSON.stringify(probs), issuedAt, t, visibility, reasoning ?? null, m.reasoningHash.toLowerCase(), m.receiptHash.toLowerCase(), digest, leaf, signature);
  return { id: Number(r.lastInsertRowid), leaf, digest, received_at: new Date(t * 1000).toISOString(), sealed_until: visibility === 0 ? new Date(mk.trading_deadline * 1000).toISOString() : null };
}

/** leaf = keccak256(typed-data digest ‖ agent address). Publishing it reveals nothing about the forecast. */
export const leafOf = (digest: string, agent: string) => keccak256(concat([digest as Hex, agent as Hex]));

/** What the public may see of a forecast right now. Sealed content appears once trading on its market has closed. */
export function forecastView(f: any, deadline: number) {
  const open = f.visibility === 1 || now() >= deadline;
  const v: any = { id: f.id, agent: f.agent, market: f.market, leaf: f.leaf, received_at: new Date(f.received_ts * 1000).toISOString(), sealed: !open, batch: f.batch };
  if (open) Object.assign(v, { probabilities: (JSON.parse(f.probs) as number[]).map((p) => p / 10000), issued_at: f.issued_at, visibility: f.visibility, reasoning: f.reasoning, reasoning_hash: f.reasoning_hash, receipt_hash: f.receipt_hash, digest: f.digest, signature: f.signature });
  return v;
}

// ───────────────────────── Merkle batches

const pair = (a: Hex, b: Hex) => keccak256(a.toLowerCase() <= b.toLowerCase() ? concat([a, b]) : concat([b, a]));
function layers(leaves: Hex[]): Hex[][] {
  const out = [leaves];
  while (out[out.length - 1].length > 1) {
    const cur = out[out.length - 1], next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? pair(cur[i], cur[i + 1]) : cur[i]); // an odd leaf is carried up
    out.push(next);
  }
  return out;
}
export const merkleRoot = (leaves: Hex[]) => layers(leaves).at(-1)![0];
export function merkleProof(leaves: Hex[], index: number): Hex[] {
  const proof: Hex[] = [];
  for (const layer of layers(leaves).slice(0, -1)) {
    const sib = index ^ 1;
    if (sib < layer.length) proof.push(layer[sib]);
    index >>= 1;
  }
  return proof;
}
export const merkleVerify = (leaf: Hex, proof: Hex[], root: Hex) => proof.reduce((h, p) => pair(h, p), leaf).toLowerCase() === root.toLowerCase();

/** Group every forecast not yet in a batch into one, and record its root. Returns null when there is nothing new. */
export function buildBatch(): { id: number; root: string; count: number } | null {
  return tx(() => {
    const rows = db.prepare("SELECT id, leaf FROM league_forecasts WHERE batch IS NULL ORDER BY id").all() as any[];
    if (!rows.length) return null;
    const root = merkleRoot(rows.map((r) => r.leaf));
    const id = Number(db.prepare("INSERT INTO league_batches(root, count, created_ts) VALUES(?,?,?)").run(root, rows.length, now()).lastInsertRowid);
    db.prepare(`UPDATE league_forecasts SET batch = ? WHERE batch IS NULL AND id <= ?`).run(id, rows[rows.length - 1].id);
    return { id, root, count: rows.length };
  });
}

export function proofFor(forecastId: number) {
  const f = db.prepare("SELECT id, leaf, batch FROM league_forecasts WHERE id = ?").get(forecastId) as any;
  if (!f) return null;
  if (f.batch == null) return { leaf: f.leaf, batch: null, note: "not in a batch yet; batches are built every few minutes" };
  const b = db.prepare("SELECT * FROM league_batches WHERE id = ?").get(f.batch) as any;
  const leaves = (db.prepare("SELECT id, leaf FROM league_forecasts WHERE batch = ? ORDER BY id").all(f.batch) as any[]);
  const proof = merkleProof(leaves.map((l) => l.leaf), leaves.findIndex((l) => l.id === f.id));
  return { leaf: f.leaf, batch: b.id, root: b.root, count: b.count, proof, anchored: !!b.anchored, chain_batch: b.chain_batch, contract: b.contract, tx: b.tx, block: b.block };
}

// ───────────────────────── scoring

const brier = (p: number[], w: number) => p.reduce((a, x, j) => a + (x - (j === w ? 1 : 0)) ** 2, 0) / 2;
const qPrices = db.prepare("SELECT ts, probs FROM prices WHERE market = ? AND ts <= ? ORDER BY block, log_index");

/**
 * Points = 100 × (B_market − B_agent) × coverage, over the period from the agent's first forecast to trading close.
 * Copying the market price scores zero; being closer to the truth than the price scores above it.
 */
export function scoreMarket(address: string): number {
  const m = fixture(address);
  db.prepare("DELETE FROM league_scores WHERE market = ?").run(address);
  if (!m || m.status !== "settled" || m.winning_outcome == null || !m.resolved_ts) return 0;
  const T: number = m.trading_deadline, t0: number = m.created_ts, w: number = m.winning_outcome, n: number = m.outcome_count;
  const path: [number, number[]][] = [[t0, Array(n).fill(1 / n)], ...(qPrices.all(address, T) as any[]).map((r) => [r.ts, JSON.parse(r.probs)] as [number, number[]])];
  const fs = db.prepare("SELECT agent, probs, received_ts FROM league_forecasts WHERE market = ? AND received_ts < ? ORDER BY agent, received_ts, id").all(address, T) as any[];
  const by = new Map<string, any[]>();
  for (const f of fs) (by.get(f.agent) ?? by.set(f.agent, []).get(f.agent)!).push(f);
  const ins = db.prepare("INSERT INTO league_scores VALUES(?,?,?,?,?,?,?,?,?,?)");
  for (const [agent, list] of by) {
    const t1: number = list[0].received_ts, span = T - t1;
    if (span <= 0) continue;
    let bAgent = 0, bMarket = 0;
    list.forEach((f, i) => { const end = i + 1 < list.length ? list[i + 1].received_ts : T; bAgent += brier((JSON.parse(f.probs) as number[]).map((p) => p / 10000), w) * (end - f.received_ts); });
    path.forEach(([ts, p], i) => { const a = Math.max(ts, t1), b = Math.min(i + 1 < path.length ? path[i + 1][0] : T, T); if (b > a) bMarket += brier(p, w) * (b - a); });
    bAgent /= span; bMarket /= span;
    const coverage = Math.min(1, Math.max(0, span / Math.max(1, T - t0)));
    ins.run(agent, address, Math.round(100 * (bMarket - bAgent) * coverage * 1e4) / 1e4, bAgent, bMarket, coverage, t1, list.length, seasonOf(m.resolved_ts), m.resolved_ts);
  }
  return by.size;
}

/** Re-score every settled fixture that has forecasts. Cheap, and safe to run any time. */
export function scoreAll() {
  const ms = db.prepare(`SELECT DISTINCT f.market FROM league_forecasts f JOIN markets m ON m.address = f.market WHERE m.status = 'settled'`).all() as any[];
  let n = 0; tx(() => { for (const r of ms) n += scoreMarket(r.market); });
  return { markets: ms.length, scores: n };
}

// ───────────────────────── tables

export function forecasterTable(season: number) {
  const rows = db.prepare(`SELECT a.address, a.name, a.model, a.client, COALESCE(SUM(s.points), 0) points, COUNT(s.market) markets,
      (SELECT COUNT(*) FROM league_forecasts f WHERE f.agent = a.address) forecasts,
      (SELECT COUNT(DISTINCT f.market) FROM league_forecasts f JOIN markets m ON m.address = f.market WHERE f.agent = a.address AND m.status = 'open') open_markets
    FROM league_agents a LEFT JOIN league_scores s ON s.agent = a.address AND s.season = ? GROUP BY a.address`).all(season) as any[];
  return rows.map((r) => ({ ...r, points: Math.round(r.points * 100) / 100, ranked: r.markets >= RANK_MIN_FORECAST }))
    .sort((x, y) => Number(y.ranked) - Number(x.ranked) || y.points - x.points || y.markets - x.markets || y.forecasts - x.forecasts);
}

export function traderTable(season: number) {
  const w = seasonWindow(season);
  const rows = db.prepare(`SELECT a.address, a.name, a.model, COUNT(*) markets, ROUND(SUM(wm.pnl), 2) profit, ROUND(SUM(wm.cost), 2) cost, SUM(COALESCE(wm.won, 0)) wins, SUM(wm.resolved) resolved
    FROM league_agents a JOIN wallet_markets wm ON wm.wallet = a.address JOIN markets m ON m.address = wm.market
    WHERE wm.closed = 1 AND ${FIXTURE_SQL.replace(/\b(metadata_verified|trading_deadline|created_ts)\b/g, "m.$1")} AND COALESCE(m.resolved_ts, m.settlement_deadline) >= ? AND COALESCE(m.resolved_ts, m.settlement_deadline) < ?
    GROUP BY a.address`).all(w.starts, w.ends) as any[];
  return rows.map((r) => ({ ...r, return: r.cost > 0 ? Math.round((r.profit / r.cost) * 1e4) / 1e4 : null, ranked: r.markets >= RANK_MIN_TRADES && r.cost >= RANK_MIN_COST }))
    .sort((x, y) => Number(y.ranked) - Number(x.ranked) || y.profit - x.profit);
}
