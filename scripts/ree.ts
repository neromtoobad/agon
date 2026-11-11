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

/** Optional cap on processor cores for the container (AGON_REE_CPUS=4), so a scheduled run leaves the machine usable. */
const CPUS = process.env.AGON_REE_CPUS ? ["--cpus", process.env.AGON_REE_CPUS] : [];
export function ree(args: string[]): { code: number; log: string } {
  const r = spawnSync("docker", ["run", "--rm", ...CPUS, "-v", `${CACHE}:${IN}`, IMAGE, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "..", "data");
/** A wallet kept in data/<file>, made on first use. If `envKey` names a set environment variable, that key is used instead (hosted runs). */
export function wallet(file: string, envKey?: string) {
  if (envKey && process.env[envKey]) return privateKeyToAccount(process.env[envKey] as `0x${string}`);
  const p = join(DATA, file);
  mkdirSync(DATA, { recursive: true });
  if (!existsSync(p)) writeFileSync(p, JSON.stringify({ privateKey: generatePrivateKey() }, null, 2), { mode: 0o600 });
  return privateKeyToAccount(JSON.parse(readFileSync(p, "utf8")).privateKey);
}

/** The benchmark's models: bench/models.json, a list of { id, name }. */
export const roster = (): { id: string; name: string }[] => JSON.parse(readFileSync(join(HERE, "..", "bench", "models.json"), "utf8"));

/** One wallet per benchmark model, so each model has its own record. Keys come from AGON_BENCH_KEYS (JSON, model id to key) or data/agon-bench.json. */
export function benchWallet(model: string) {
  if (process.env.AGON_BENCH_KEYS) {
    const k = JSON.parse(process.env.AGON_BENCH_KEYS)[model];
    if (!k) throw new Error(`AGON_BENCH_KEYS has no key for ${model}`);
    return privateKeyToAccount(k);
  }
  const p = join(DATA, "agon-bench.json");
  mkdirSync(DATA, { recursive: true });
  const all = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  if (!all[model]) { all[model] = generatePrivateKey(); writeFileSync(p, JSON.stringify(all, null, 2), { mode: 0o600 }); }
  return privateKeyToAccount(all[model]);
}

/** A model run can take minutes, by which time an idle connection to the server has been dropped, or the server may be restarting.
 * Ask for a fresh connection and retry for about a minute and a half. */
async function fresh(url: string, init?: RequestInit): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), connection: "close" } });
      if (r.status < 502 || r.status > 504) return r; // 502 to 504 is the host saying the server is not up yet
      last = new Error(`server answered ${r.status}`);
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
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
