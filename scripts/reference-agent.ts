// The reference agent: an open model run locally in REE on the strict tier.
// Every forecast it sends carries a receipt, so anyone can re-run it and get the same answer.
//
//   node scripts/reference-agent.ts [base URL] [--model Qwen/Qwen3-0.6B] [--limit 3] [--name Athena]
//
// It forecasts the fixtures that close soonest and that it has not forecast yet. It costs no model API spend.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE, ZERO32, ree, inside, newestReceipt, wallet, post, get, register } from "./ree.ts";
import { parseForecast, receiptHashHex } from "../src/receipt.ts";

const argv = process.argv.slice(2);
const flag = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BASE = argv[0] && !argv[0].startsWith("--") ? argv[0] : "http://localhost:8787";
const MODEL = flag("--model", "Qwen/Qwen3-0.6B"), LIMIT = Number(flag("--limit", "3")), NAME = flag("--name", "Athena");

const account = wallet("agon-reference.json");
const { domain, types } = await register(BASE, account, { name: NAME, client: "reference agent (REE, strict tier)", model: MODEL, uri: "https://github.com/neromtoobad/agon/blob/main/scripts/reference-agent.ts" });
console.log(`${NAME} ${account.address} · ${MODEL} · ${BASE}`);

const { fixtures } = await get(BASE, "/league/v1/fixtures");
const mine = await get(BASE, `/league/v1/agents/${account.address}?limit=500`);
const done = new Set((mine.forecasts ?? []).map((f: any) => f.market));
const targets = fixtures.filter((f: any) => !done.has(f.market)).slice(0, LIMIT);
console.log(`${fixtures.length} open fixtures, ${done.size} already forecast, doing ${targets.length}`);

const work = join(CACHE, "work", "reference");
mkdirSync(work, { recursive: true });

for (const fx of targets) {
  const { prompt } = await get(BASE, `/league/v1/markets/${fx.market}/strict-prompt?model=${encodeURIComponent(MODEL)}`);
  const file = join(work, `${fx.market}.jsonl`);
  writeFileSync(file, JSON.stringify({ prompt }) + "\n");
  const started = Date.now();
  const run = ree(["run-all", "--tasks-root", inside(join(CACHE, "gensyn")), "--model-name", MODEL, "--prompt-file", inside(file), "--max-new-tokens", "48", "--no-do-sample", "--cpu-only"]);
  const found = run.code === 0 ? newestReceipt(join(CACHE, "gensyn"), started) : null, receipt = found?.json;
  const secs = Math.round((Date.now() - started) / 1000);
  if (!receipt) { console.log(`✗ ${fx.question.slice(0, 60)} — REE failed (exit ${run.code}) after ${secs}s`); continue; }
  const parsed = parseForecast(receipt.output.text_output, fx.outcomes);
  if ("error" in parsed) { console.log(`✗ ${fx.question.slice(0, 60)} — ${parsed.error}: ${JSON.stringify(receipt.output.text_output).slice(0, 80)}`); continue; }
  const message = { market: fx.market, probabilities: parsed.bps, issuedAt: Math.floor(Date.now() / 1000), visibility: 1, reasoningHash: ZERO32, receiptHash: receiptHashHex(receipt) };
  const signature = await account.signTypedData({ domain, types, primaryType: "Forecast", message: { ...message, issuedAt: BigInt(message.issuedAt) } });
  const res = await post(BASE, "/league/v1/forecasts", { address: account.address, message, signature, receipt: found!.text });
  console.log(`${res.ok ? "✓" : "✗"} ${fx.question.slice(0, 60)} — ${fx.outcomes.map((o: string, i: number) => `${o} ${(parsed.bps[i] / 100).toFixed(0)}%`).slice(0, 3).join(", ")} · ${secs}s · ${res.ok ? `forecast ${res.body.id}, ${res.body.receipt?.tier} tier` : res.body.error}`);
}
