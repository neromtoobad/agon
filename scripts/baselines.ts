// Three baseline agents for the Agon scoreboard, and a worked example of the client side:
// register with a signed message, read the fixtures, sign and send a forecast for each.
//
//   node scripts/baselines.ts [http://localhost:8787]
//
// They are reference lines, not contenders. "Price Echo" should score about zero by construction,
// "Even Odds" shows what ignoring the market costs, and "Favourite Plus" tests sealed forecasts.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const BASE = process.argv[2] ?? "http://localhost:8787";
const KEYS = process.env.AGON_BASELINE_KEYS ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data", "agon-baselines.json");
const ZERO32 = "0x" + "0".repeat(64);

type Strategy = (p: number[]) => number[];
const AGENTS: { key: string; name: string; model: string; visibility: 0 | 1; f: Strategy }[] = [
  { key: "even", name: "Even Odds", model: "baseline: every outcome equally likely", visibility: 1, f: (p) => p.map(() => 1 / p.length) },
  { key: "echo", name: "Price Echo", model: "baseline: repeats the market price", visibility: 1, f: (p) => p },
  { key: "fav", name: "Favourite Plus", model: "baseline: leans a little further toward the favourite", visibility: 0, f: (p) => { const q = p.map((x) => x ** 1.5), s = q.reduce((a, b) => a + b, 0); return q.map((x) => x / s); } },
];

/** Whole basis points per outcome, each from 100 to 9900, adding up to exactly 10000. */
export function toBps(p: number[]): number[] {
  const n = p.length, floor = 100, room = 10000 - floor * n, sum = p.reduce((a, b) => a + Math.max(b, 0), 0) || 1;
  const out = p.map((x) => floor + Math.floor((room * Math.max(x, 0)) / sum));
  let rest = 10000 - out.reduce((a, b) => a + b, 0);
  const order = p.map((x, i) => [x, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  for (let k = 0; rest > 0; k = (k + 1) % n, rest--) out[order[k]]++;
  const top = order[0];
  if (out[top] > 9900) { const extra = out[top] - 9900; out[top] = 9900; out[order[1]] += extra; }
  return out;
}

async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, body: await r.json() as any };
}

const keys: Record<string, `0x${string}`> = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, "utf8")) : {};
for (const a of AGENTS) keys[a.key] ??= generatePrivateKey();
mkdirSync(dirname(KEYS), { recursive: true });
writeFileSync(KEYS, JSON.stringify(keys, null, 2), { mode: 0o600 });

const { domain, types } = (await (await fetch(BASE + "/league/v1/signing")).json()) as any;
const { fixtures } = (await (await fetch(BASE + "/league/v1/fixtures")).json()) as any;
console.log(`${fixtures.length} open fixtures at ${BASE}`);

for (const a of AGENTS) {
  const account = privateKeyToAccount(keys[a.key]);
  const now = () => Math.floor(Date.now() / 1000);
  const reg = { name: a.name, uri: "https://github.com/neromtoobad/agon/blob/main/scripts/baselines.ts", client: "baseline", model: a.model, issuedAt: now() };
  const sig = await account.signTypedData({ domain, types, primaryType: "Agent", message: { ...reg, issuedAt: BigInt(reg.issuedAt) } });
  const r = await post("/league/v1/agents", { address: account.address, message: reg, signature: sig });
  if (!r.ok && !/newer registration/.test(r.body.error ?? "")) { console.log(`${a.name}: registration refused: ${r.body.error}`); continue; }

  let sent = 0, refused = 0; const why = new Map<string, number>();
  for (const fx of fixtures) {
    if (!fx.probabilities) continue;
    const message = { market: fx.market, probabilities: toBps(a.f(fx.probabilities)), issuedAt: now(), visibility: a.visibility, reasoningHash: ZERO32, receiptHash: ZERO32 };
    const signature = await account.signTypedData({ domain, types, primaryType: "Forecast", message: { ...message, issuedAt: BigInt(message.issuedAt) } });
    const res = await post("/league/v1/forecasts", { address: account.address, message, signature });
    if (res.ok) sent++; else { refused++; why.set(res.body.error, (why.get(res.body.error) ?? 0) + 1); }
  }
  console.log(`${a.name.padEnd(15)} ${account.address}  sent ${sent}, refused ${refused}${refused ? "  " + [...why].map(([k, v]) => `${v}× ${k}`).join("; ") : ""}`);
}
