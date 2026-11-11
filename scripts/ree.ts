// Shared helpers for the reference agent and the verifier: run Gensyn's REE container, find the receipt it wrote,
// and keep a local wallet. REE needs Docker and the image `gensynai/ree` (pulling it accepts the REE Binary Licence).

import { spawnSync } from "node:child_process";
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const IMAGE = process.env.AGON_REE_IMAGE ?? "gensynai/ree:v0.8.0";
/** Mounted into the container as its cache. A dedicated folder, so the container never sees the rest of ~/.cache. */
export const CACHE = process.env.AGON_REE_CACHE ?? join(homedir(), ".cache", "tripod-ree");
const IN = "/home/gensyn/.cache";
export const ZERO32 = "0x" + "0".repeat(64);

export function ree(args: string[]): { code: number; log: string } {
  const r = spawnSync("docker", ["run", "--rm", "-v", `${CACHE}:${IN}`, IMAGE, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, log: (r.stdout ?? "") + (r.stderr ?? "") };
}
/** Path inside the container for a file under CACHE. */
export const inside = (hostPath: string) => hostPath.replace(CACHE, IN);

/** Newest receipt under a tasks root written at or after `since` (ms): its exact text and its parsed form. */
export function newestReceipt(tasksRoot: string, since: number): { text: string; json: any } | null {
  let best: { path: string; t: number } | null = null;
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n), st = statSync(p);
      if (st.isDirectory()) { if (n !== "model") walk(p); }
      else if (/^receipt_.*\.json$/.test(n) && st.mtimeMs >= since - 2000 && (!best || st.mtimeMs > best.t)) best = { path: p, t: st.mtimeMs };
    }
  };
  if (existsSync(tasksRoot)) walk(tasksRoot);
  if (!best) return null;
  const text = readFileSync((best as { path: string }).path, "utf8");
  return { text, json: JSON.parse(text) };
}

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
export function wallet(file: string) {
  const p = join(DATA, file);
  mkdirSync(DATA, { recursive: true });
  if (!existsSync(p)) writeFileSync(p, JSON.stringify({ privateKey: generatePrivateKey() }, null, 2), { mode: 0o600 });
  return privateKeyToAccount(JSON.parse(readFileSync(p, "utf8")).privateKey);
}

/** A model run can take minutes, by which time an idle connection to the server has been dropped. Ask for a fresh one and retry. */
async function fresh(url: string, init?: RequestInit): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try { return await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), connection: "close" } }); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 500 * (i + 1))); }
  }
  throw last;
}
export async function post(base: string, path: string, body: unknown) {
  const r = await fresh(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, body: (await r.json()) as any };
}
export const get = async (base: string, path: string) => (await (await fresh(base + path)).json()) as any;

export async function register(base: string, account: ReturnType<typeof wallet>, info: { name: string; client: string; model: string; uri: string }) {
  const { domain, types } = await get(base, "/league/v1/signing");
  const message = { ...info, issuedAt: Math.floor(Date.now() / 1000) };
  const signature = await account.signTypedData({ domain, types, primaryType: "Agent", message: { ...message, issuedAt: BigInt(message.issuedAt) } });
  const r = await post(base, "/league/v1/agents", { address: account.address, message, signature });
  if (!r.ok && !/newer registration/.test(r.body.error ?? "")) throw new Error("registration refused: " + r.body.error);
  return { domain, types };
}
