// A verifier: re-runs receipts attached to forecasts and reports, signed, what came out.
// Anyone with Docker can run one. The scoreboard never trusts the text inside a submitted receipt;
// it reads the forecast from a verifier's own re-run.
//
//   node scripts/verifier.ts [base URL] [--limit 5] [--name "House Verifier"] [--model Qwen/Qwen3-0.6B] [--all]
//
// By default it takes receipts nobody has re-run. With --all it takes every receipt this verifier has not re-run itself,
// so a second machine can confirm what a first one already reproduced. AGON_VERIFIER_KEY overrides the saved key.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { CACHE, ree, inside, newestReceipt, wallet, post, get, register } from "./ree.ts";

const argv = process.argv.slice(2);
const flag = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BASE = argv[0] && !argv[0].startsWith("--") ? argv[0] : "http://localhost:8787";
const LIMIT = Number(flag("--limit", "5")), NAME = flag("--name", "House Verifier"), ONLY = flag("--model", ""), ALL = argv.includes("--all");

const account = wallet("agon-verifier.json", "AGON_VERIFIER_KEY");
const { domain, types } = await register(BASE, account, { name: NAME, client: "verifier", model: "re-runs receipts in REE; does not forecast", uri: "https://github.com/neromtoobad/agon/blob/main/scripts/verifier.ts" });
console.log(`${NAME} ${account.address} · ${BASE}`);

const { receipts } = await get(BASE, `/league/v1/receipts?limit=500&status=${ALL ? "all" : "attached"}&unverified_by=${account.address}${ONLY ? `&model=${encodeURIComponent(ONLY)}` : ""}`);
const seen = new Set<string>();
const todo = receipts.filter((r: any) => !seen.has(r.receipt_hash) && seen.add(r.receipt_hash)).slice(0, LIMIT);
console.log(`${receipts.length} forecasts wait for a re-run (${seen.size} distinct receipts), doing ${todo.length}`);

const work = join(CACHE, "work", "verify");
mkdirSync(work, { recursive: true });

for (const r of todo) {
  const full = await get(BASE, `/league/v1/forecasts/${r.forecast}/receipt`);
  if (!full.receipt_text) { console.log(`– forecast ${r.forecast}: receipt is still sealed`); continue; }
  const file = join(work, `${r.receipt_hash}.json`);
  writeFileSync(file, full.receipt_text); // exactly as the agent sent it
  const started = Date.now();
  // A separate tasks root, so the re-run cannot reuse anything the original run left behind except the model weights.
  const run = ree(["verify", "--tasks-root", inside(join(CACHE, "gensyn-verify")), "--receipt-path", inside(file), "--cpu-only"]);
  const matched = run.code === 0 && /VERIFICATION PASSED/.test(run.log);
  // Only a completed re-run is evidence. If REE could not run at all, say so here and report nothing.
  if (!matched && !/VERIFICATION FAILED/.test(run.log)) {
    console.log(`? ${r.model} forecast ${r.forecast} — REE did not complete: ${(run.log.match(/E gensyn_sdk[^\n]*/) ?? [`exit ${run.code}`])[0].slice(0, 160)}`);
    continue;
  }
  const mine = newestReceipt(join(CACHE, "gensyn-verify"), started)?.json;
  const output: string = mine?.output?.text_output ?? "";
  const message = { receiptHash: r.receipt_hash, matched, outputHash: keccak256(toHex(output)), reeVersion: String(mine?.ree_version ?? ""), issuedAt: Math.floor(Date.now() / 1000) };
  const signature = await account.signTypedData({ domain, types, primaryType: "Verification", message: { ...message, issuedAt: BigInt(message.issuedAt) } });
  const res = await post(BASE, "/league/v1/verifications", { address: account.address, message, signature, output });
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`${matched ? "✓" : "✗"} ${r.model} forecast ${r.forecast} — re-run ${matched ? "matched" : "did not match"} in ${secs}s · ${res.ok ? res.body.forecasts.map((f: any) => `${f.forecast}: ${f.status}${f.reason ? ` (${f.reason})` : ""}`).join(", ") : res.body.error}`);
}
