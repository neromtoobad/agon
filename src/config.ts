import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Network {
  name: string;
  chainId: number;
  rpcUrl: string;
  rpcMaxLogRange: number;
  explorerUrl: string;
  appUrl: string;
  multicall3: `0x${string}`;
  collateral: { symbol: string; address: string; decimals: number };
  startBlock: number;
  listed: { sdk: { source: string; gateways: string[]; factories: string[] } };
}

const name = process.env.TRIPOD_NETWORK ?? "mainnet";
const net = JSON.parse(readFileSync(join(ROOT, "networks", `${name}.json`), "utf8")) as Network;
if (process.env.GENSYN_RPC_URL) net.rpcUrl = process.env.GENSYN_RPC_URL;
if (process.env.TRIPOD_RPC_MAX_LOG_RANGE) net.rpcMaxLogRange = Number(process.env.TRIPOD_RPC_MAX_LOG_RANGE);

export const network = net;
export const DB_PATH = process.env.TRIPOD_DB ?? join(ROOT, "data", `${net.name}.db`);
export const PORT = Number(process.env.PORT ?? 8787);
/** "explorer" backfills fast through the block explorer's log API; "rpc" reads only from the JSON-RPC node. */
export const LOG_SOURCE = (process.env.TRIPOD_SOURCE ?? "explorer") as "explorer" | "rpc";
export const POLL_MS = Number(process.env.TRIPOD_POLL_MS ?? 15000);
export const VERIFY_EVERY_MS = Number(process.env.TRIPOD_VERIFY_EVERY_MS ?? 6 * 3600 * 1000);
export const ANCHOR_EVERY_MS = Number(process.env.AGON_ANCHOR_EVERY_MS ?? 10 * 60 * 1000);
export const ADMIN_TOKEN = process.env.TRIPOD_ADMIN_TOKEN ?? "";
export const UA = "agon/0.1 (+open scoreboard and data layer for Delphi)";

export const lc = (a: string) => a.toLowerCase();
