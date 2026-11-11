import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./config.ts";

mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS contracts (
  address TEXT PRIMARY KEY, role TEXT NOT NULL, mechanism TEXT, factory TEXT,
  listed INTEGER NOT NULL DEFAULT 0, listed_source TEXT, explorer_name TEXT, verified INTEGER,
  first_block INTEGER, last_block INTEGER, first_ts INTEGER, last_ts INTEGER, n_events INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  block INTEGER NOT NULL, log_index INTEGER NOT NULL, ts INTEGER, tx TEXT NOT NULL,
  emitter TEXT NOT NULL, kind TEXT NOT NULL, market TEXT NOT NULL, wallet TEXT, outcome_idx INTEGER,
  tokens TEXT, shares TEXT, extra TEXT,
  PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS events_market ON events(market, block, log_index);
CREATE INDEX IF NOT EXISTS events_wallet ON events(wallet, block);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, block);
CREATE TABLE IF NOT EXISTS markets (
  address TEXT PRIMARY KEY, factory TEXT NOT NULL, gateway TEXT, mechanism TEXT NOT NULL,
  creator TEXT, implementation TEXT, created_block INTEGER, created_ts INTEGER, created_tx TEXT,
  outcome_count INTEGER, liquidity_param TEXT, trading_fee REAL,
  trading_deadline INTEGER, earliest_resolve INTEGER, settlement_deadline INTEGER, init_shares TEXT,
  metadata_uri TEXT, metadata_hash TEXT, metadata_verified INTEGER, metadata_raw TEXT,
  question TEXT, outcomes TEXT, criteria TEXT, data_sources TEXT, judge_model TEXT, category TEXT,
  status TEXT, winning_outcome INTEGER, resolved_ts INTEGER, resolved_tx TEXT, resolution_requested_ts INTEGER,
  probs TEXT, close_probs TEXT, volume REAL DEFAULT 0, n_trades INTEGER DEFAULT 0, n_traders INTEGER DEFAULT 0,
  first_trade_ts INTEGER, last_trade_ts INTEGER, chain_read_block INTEGER
);
CREATE INDEX IF NOT EXISTS markets_status ON markets(status);
CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, block INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, secret TEXT NOT NULL, kinds TEXT, created_ts INTEGER,
  last_status INTEGER, last_ts INTEGER, failures INTEGER NOT NULL DEFAULT 0
);
`);

export const getMeta = (k: string): string | undefined => (db.prepare("SELECT value FROM meta WHERE key=?").get(k) as any)?.value;
export const setMeta = (k: string, v: string) => db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v);
export const getCursor = (k: string): number | undefined => (db.prepare("SELECT block FROM cursors WHERE key=?").get(k) as any)?.block;
export const setCursor = (k: string, b: number) => db.prepare("INSERT INTO cursors(key,block) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET block=excluded.block").run(k, b);
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
}
