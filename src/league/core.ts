import { keccak256, concat, hashTypedData, verifyTypedData, isAddress, toHex, type Hex } from "viem";
import { db, tx } from "../db.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { network, lc, ROOT } from "../config.ts";
import { checkReceipt, validateReceipt, parseForecast, buildPrompt, receiptHashHex, STRICT_PACK, directiveFor, type Receipt, type MarketText } from "../receipt.ts";

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
  Verification: [
    { name: "receiptHash", type: "bytes32" }, { name: "matched", type: "bool" }, { name: "outputHash", type: "bytes32" },
    { name: "reeVersion", type: "string" }, { name: "issuedAt", type: "uint64" },
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
CREATE TABLE IF NOT EXISTS league_receipts (
  forecast_id INTEGER PRIMARY KEY, receipt_hash TEXT NOT NULL, receipt TEXT NOT NULL, model TEXT, revision TEXT, ree_version TEXT,
  tier TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'attached'
);
CREATE INDEX IF NOT EXISTS lr_hash ON league_receipts(receipt_hash);
CREATE TABLE IF NOT EXISTS league_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_hash TEXT NOT NULL, verifier TEXT NOT NULL, matched INTEGER NOT NULL,
  output TEXT, output_hash TEXT NOT NULL, ree_version TEXT, issued_at INTEGER NOT NULL, received_ts INTEGER NOT NULL, signature TEXT NOT NULL,
  UNIQUE (receipt_hash, verifier)
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

export async function submitForecast(input: { address: string; message: any; signature: string; reasoning?: string; receipt?: string }) {
  const { address, message: m, signature, reasoning } = input ?? ({} as any);
  // The receipt must be the receipt file's text, byte for byte. Re-serialising it changes number formatting (1.0 becomes 1)
  // and REE then rejects it as inconsistent, so it is kept and served exactly as received.
  const receiptText: string | undefined = input?.receipt;
  let receipt: Receipt | undefined;
  if (receiptText != null) {
    if (typeof receiptText !== "string" || receiptText.length > 400000) refuse("receipt must be the text of the receipt file, unmodified");
    try { receipt = JSON.parse(receiptText); } catch { refuse("receipt is not valid JSON"); }
  }
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
  // A receipt is optional. When one is attached it must be well formed, be about this market, and say what the forecast says.
  let tier: "strict" | "open" | null = null;
  if (receipt != null) {
    if (typeof receipt !== "object" || !receipt.input?.prompt || !receipt.hashes?.receipt_hash) refuse("receipt is not an REE receipt");
    if (receiptHashHex(receipt) !== String(m.receiptHash).toLowerCase()) refuse("receiptHash in the signed message is not this receipt's hash");
    const text = marketText(mk);
    const strictPrompt = buildPrompt(text, STRICT_PACK, directiveFor(receipt.model?.name ?? ""));
    tier = receipt.input.prompt === strictPrompt ? "strict" : "open";
    const chk = checkReceipt(receipt, text, probs, receipt.output?.text_output ?? "", tier === "strict" ? STRICT_PACK : undefined, tier === "strict" ? directiveFor(receipt.model?.name ?? "") : undefined);
    if (!chk.ok) refuse("receipt refused: " + chk.reasons.join("; "));
  } else if (m.receiptHash !== ZERO32) refuse("receiptHash is set but no receipt was sent");
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
  const id = Number(r.lastInsertRowid);
  if (receipt && tier) {
    const rh = receiptHashHex(receipt);
    // If someone already re-ran this exact receipt, judge this forecast against what that re-run said, not against the receipt's own text.
    const status = statusFromReruns(rh, probs, JSON.parse(mk.outcomes));
    db.prepare("INSERT INTO league_receipts(forecast_id, receipt_hash, receipt, model, revision, ree_version, tier, status) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, rh, receiptText!, receipt.model.name, receipt.model.commit_hash, receipt.ree_version ?? null, tier, status);
    return { id, leaf, digest, received_at: new Date(t * 1000).toISOString(), sealed_until: visibility === 0 ? new Date(mk.trading_deadline * 1000).toISOString() : null, receipt: { tier, status } };
  }
  return { id, leaf, digest, received_at: new Date(t * 1000).toISOString(), sealed_until: visibility === 0 ? new Date(mk.trading_deadline * 1000).toISOString() : null, receipt: null };
}

const marketText = (mk: any): MarketText => ({ address: mk.address, metadataHash: mk.metadata_hash, question: mk.question, outcomes: JSON.parse(mk.outcomes), criteria: mk.criteria ?? "" });
/** The exact prompt a strict-tier agent must run for a market and model. Public, so anyone can reproduce it. */
export function strictPrompt(address: string, model: string) { const mk = fixture(address); return mk ? buildPrompt(marketText(mk), STRICT_PACK, directiveFor(model)) : null; }

/**
 * A verifier re-ran a receipt in REE and reports what came out. The badge "reproduced" needs the re-run to match
 * AND the verifier's own output to say what the forecast says. The text inside a submitted receipt is never trusted.
 */
export async function submitVerification(input: { address: string; message: any; signature: string; output: string }) {
  const { address, message: m, signature, output } = input ?? ({} as any);
  if (!address || !isAddress(address)) refuse("address is missing or malformed");
  const v = lc(address);
  if (!db.prepare("SELECT 1 FROM league_agents WHERE address = ?").get(v)) refuse("verifiers must be registered wallets");
  if (!m || !/^0x[0-9a-fA-F]{64}$/.test(m.receiptHash ?? "") || typeof m.matched !== "boolean") refuse("message is missing fields");
  if (typeof output !== "string" || output.length > 20000) refuse("output must be the text your re-run produced");
  if (keccak256(toHex(output)) !== String(m.outputHash).toLowerCase()) refuse("outputHash is not the hash of the output text");
  const issuedAt = Number(m.issuedAt);
  if (!Number.isFinite(issuedAt) || Math.abs(issuedAt - now()) > CLOCK_SKEW) refuse("issuedAt must be within ten minutes of now");
  const ok = await verifyTypedData({ address: address as Hex, domain: DOMAIN, types: TYPES, primaryType: "Verification", message: { receiptHash: m.receiptHash, matched: m.matched, outputHash: m.outputHash, reeVersion: String(m.reeVersion ?? ""), issuedAt: BigInt(issuedAt) }, signature: signature as Hex }).catch(() => false);
  if (!ok) refuse("signature does not match this address and message");
  const rh = String(m.receiptHash).toLowerCase();
  const rows = db.prepare("SELECT r.forecast_id, f.probs, f.market FROM league_receipts r JOIN league_forecasts f ON f.id = r.forecast_id WHERE r.receipt_hash = ?").all(rh) as any[];
  if (!rows.length) refuse("no forecast carries this receipt");
  db.prepare(`INSERT INTO league_verifications(receipt_hash, verifier, matched, output, output_hash, ree_version, issued_at, received_ts, signature) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(receipt_hash, verifier) DO UPDATE SET matched=excluded.matched, output=excluded.output, output_hash=excluded.output_hash, ree_version=excluded.ree_version, issued_at=excluded.issued_at, received_ts=excluded.received_ts, signature=excluded.signature`)
    .run(rh, v, m.matched ? 1 : 0, output, String(m.outputHash).toLowerCase(), String(m.reeVersion ?? ""), issuedAt, now(), signature);
  const results: any[] = [];
  for (const row of rows) {
    const status = statusFromReruns(rh, JSON.parse(row.probs), JSON.parse(fixture(row.market).outcomes));
    db.prepare("UPDATE league_receipts SET status = ? WHERE forecast_id = ?").run(status, row.forecast_id);
    results.push({ forecast: row.forecast_id, status });
  }
  return { receipt_hash: rh, forecasts: results };
}

/**
 * attached   nobody has re-run this receipt yet
 * failed     some re-run produced different tokens, or its output does not say what the forecast says
 * reproduced every re-run matched, and its output says exactly what the forecast says
 * One failed report outweighs earlier passes: the badge goes until the disagreement is looked at.
 */
export function statusFromReruns(receiptHash: string, claimedBps: number[], outcomes: string[]): "attached" | "reproduced" | "failed" {
  const vs = db.prepare("SELECT matched, output FROM league_verifications WHERE receipt_hash = ?").all(receiptHash) as any[];
  if (!vs.length) return "attached";
  for (const v of vs) {
    const parsed = parseForecast(v.output ?? "", outcomes);
    const same = !("error" in parsed) && parsed.bps.length === claimedBps.length && parsed.bps.every((x, i) => x === claimedBps[i]);
    if (!v.matched || !same) return "failed";
  }
  return "reproduced";
}

export function receiptView(forecastId: number, withReceipt: boolean) {
  const r = db.prepare("SELECT * FROM league_receipts WHERE forecast_id = ?").get(forecastId) as any;
  if (!r) return null;
  const vs = db.prepare("SELECT verifier, matched, ree_version, received_ts FROM league_verifications WHERE receipt_hash = ? ORDER BY received_ts").all(r.receipt_hash) as any[];
  const v: any = { status: r.status, tier: r.tier, model: r.model, revision: r.revision, ree_version: r.ree_version,
    verifications: vs.map((x) => ({ verifier: x.verifier, matched: !!x.matched, ree_version: x.ree_version, at: new Date(x.received_ts * 1000).toISOString() })) };
  if (withReceipt) { v.receipt_hash = r.receipt_hash; v.receipt = JSON.parse(r.receipt); v.receipt_text = r.receipt; }
  return v;
}

/** leaf = keccak256(typed-data digest ‖ agent address). Publishing it reveals nothing about the forecast. */
export const leafOf = (digest: string, agent: string) => keccak256(concat([digest as Hex, agent as Hex]));

/** What the public may see of a forecast right now. Sealed content appears once trading on its market has closed. */
export function forecastView(f: any, deadline: number) {
  const open = f.visibility === 1 || now() >= deadline;
  const v: any = { id: f.id, agent: f.agent, market: f.market, leaf: f.leaf, received_at: new Date(f.received_ts * 1000).toISOString(), sealed: !open, batch: f.batch };
  if (open) Object.assign(v, { probabilities: (JSON.parse(f.probs) as number[]).map((p) => p / 10000), issued_at: f.issued_at, visibility: f.visibility, reasoning: f.reasoning, reasoning_hash: f.reasoning_hash, receipt_hash: f.receipt_hash, digest: f.digest, signature: f.signature });
  const rc = receiptView(f.id, open);
  if (rc) v.receipt = rc;
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
      (SELECT COUNT(DISTINCT f.market) FROM league_forecasts f JOIN markets m ON m.address = f.market WHERE f.agent = a.address AND m.status = 'open') open_markets,
      (SELECT COUNT(*) FROM league_receipts r JOIN league_forecasts f ON f.id = r.forecast_id WHERE f.agent = a.address) receipts,
      (SELECT COUNT(*) FROM league_receipts r JOIN league_forecasts f ON f.id = r.forecast_id WHERE f.agent = a.address AND r.status = 'reproduced') reproduced
    FROM league_agents a LEFT JOIN league_scores s ON s.agent = a.address AND s.season = ? WHERE a.client != 'verifier' GROUP BY a.address`).all(season) as any[];
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

/** Models seen in receipts: how many forecasts carry one, how many were reproduced, and the points their agents earned on those markets. */
export function modelTable(season: number) {
  let names: Record<string, string> = {};
  try { names = Object.fromEntries((JSON.parse(readFileSync(join(ROOT, "bench", "models.json"), "utf8")) as any[]).map((m) => [m.id, m.name])); } catch { /* no roster file: show model ids */ }
  const rows = db.prepare(`WITH rr AS (SELECT r.model, r.revision, r.receipt_hash, r.status, r.tier, f.agent, f.market FROM league_receipts r JOIN league_forecasts f ON f.id = r.forecast_id),
      ver AS (SELECT receipt_hash, COUNT(DISTINCT verifier) n FROM league_verifications WHERE matched = 1 GROUP BY receipt_hash)
    SELECT rr.model, rr.revision, COUNT(*) receipts, SUM(rr.status = 'reproduced') reproduced, SUM(rr.status = 'failed') failed, SUM(rr.tier = 'strict') strict,
      COUNT(DISTINCT rr.agent) agents, COUNT(DISTINCT rr.market) markets, SUM(COALESCE(ver.n, 0) >= 2) confirmed_twice
    FROM rr LEFT JOIN ver ON ver.receipt_hash = rr.receipt_hash GROUP BY rr.model, rr.revision`).all() as any[];
  // A model is scored only on forecasts that were re-run and matched: those are the ones known to be its own work.
  const scored = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(s.points), 0) p, AVG(s.b_agent) ba, AVG(s.b_market) bm FROM league_scores s WHERE s.season = ? AND EXISTS
    (SELECT 1 FROM league_receipts r2 JOIN league_forecasts f2 ON f2.id = r2.forecast_id WHERE r2.model = ? AND r2.revision = ? AND r2.status = 'reproduced' AND f2.agent = s.agent AND f2.market = s.market)`);
  const verifiers = db.prepare(`SELECT COUNT(DISTINCT v.verifier) n FROM league_verifications v WHERE v.matched = 1 AND v.receipt_hash IN (SELECT receipt_hash FROM league_receipts WHERE model = ? AND revision = ?)`);
  const entries = db.prepare(`SELECT DISTINCT f.agent address, a.name FROM league_receipts r JOIN league_forecasts f ON f.id = r.forecast_id JOIN league_agents a ON a.address = f.agent WHERE r.model = ? AND r.revision = ?`);
  return rows.map((r) => {
    const sc = scored.get(season, r.model, r.revision) as any, round = (x: number | null, d: number) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
    return { ...r, name: names[r.model] ?? r.model, entries: entries.all(r.model, r.revision), verifiers: (verifiers.get(r.model, r.revision) as any).n, scored_markets: sc.n, points: round(sc.p, 2) ?? 0, brier_model: round(sc.ba, 4), brier_market: round(sc.bm, 4) };
  }).sort((a, b) => b.points - a.points || b.reproduced - a.reproduced || b.receipts - a.receipts);
}
