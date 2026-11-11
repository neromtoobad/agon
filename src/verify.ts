import { parseAbi } from "viem";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { db, setMeta } from "./db.ts";
import { DB_PATH, UA } from "./config.ts";
import { client, readLive } from "./chain.ts";

const FACTORY_ABI = parseAbi(["function getTotalMarketProxiesCount() view returns (uint256)"]);
const GOLDSKY: Record<string, string> = {
  "0x4e4e85c52e0f414cc67ee88d0c649ec81698d700": "https://api.goldsky.com/api/public/project_cmnoqdag1obop01z3efnu8ssq/subgraphs/delphi-mainnet/1.0.0/gn",
  "0x982a67ae92d8de361957249fb2bb4a62bcc6a8d5": "https://api.goldsky.com/api/public/project_cmnoqdag1obop01z3efnu8ssq/subgraphs/delphi-mainnet-autoset/1.0.0/gn",
};

interface Check { name: string; ok: boolean; detail: string }

async function goldskyCount(url: string, coll: string): Promise<number> {
  let n = 0, last = "";
  for (;;) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify({ query: `{ ${coll}(first:1000, orderBy:id, where:{id_gt:"${last}"}){ id } }` }), signal: AbortSignal.timeout(45000) });
    const rows = ((await r.json()) as any).data?.[coll] ?? [];
    n += rows.length;
    if (rows.length < 1000) return n;
    last = rows[rows.length - 1].id;
  }
}

/**
 * Independent checks of the index against the chain itself and against Gensyn's own subgraphs.
 * Nothing here trusts Tripod's database: every expected value is read fresh from somewhere else.
 */
export async function verify(args: string[] = []) {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`); };

  // 1. Every factory's own market counter equals the number of markets indexed from it.
  for (const f of db.prepare("SELECT address FROM contracts WHERE role='factory'").all() as any[]) {
    const onchain = Number(await client.readContract({ address: f.address, abi: FACTORY_ABI, functionName: "getTotalMarketProxiesCount" }));
    const ours = (db.prepare("SELECT COUNT(*) n FROM markets WHERE factory=?").get(f.address) as any).n;
    add(`market count ${f.address.slice(0, 10)}`, onchain === ours, `chain ${onchain}, index ${ours}`);
  }

  // 2. Replayed probabilities equal the contract's own spot probabilities, and derived status equals contract status.
  const ms = db.prepare("SELECT address, gateway, outcome_count, mechanism, status, probs FROM markets WHERE gateway IS NOT NULL AND outcome_count IS NOT NULL").all() as any[];
  let worst = 0, worstAt = "", compared = 0, statusBad: string[] = [], statusN = 0;
  for (let i = 0; i < ms.length; i += 120) {
    const part = ms.slice(i, i + 120);
    const live = await readLive(part);
    live.forEach((l, j) => {
      const m = part[j];
      if (l.status) { statusN++; if (l.status !== m.status) statusBad.push(`${m.address} index=${m.status} chain=${l.status}`); }
      if (l.probs && m.status === "open" && m.probs) {
        const ours: number[] = JSON.parse(m.probs);
        const d = Math.max(...ours.map((p, k) => Math.abs(p - l.probs![k])));
        compared++;
        if (d > worst) { worst = d; worstAt = `${m.address} (${m.mechanism})`; }
      }
    });
  }
  add("replayed probabilities vs contract", worst < 1e-4, `${compared} open markets, largest gap ${worst.toExponential(2)}${worstAt ? ` at ${worstAt}` : ""}`);
  add("derived status vs contract", statusBad.length === 0, `${statusN} markets, ${statusBad.length} differ${statusBad.length ? `: ${statusBad.slice(0, 4).join("; ")}` : ""}`);

  // 3. Event counts equal Gensyn's published subgraphs for the two gateways those subgraphs cover.
  if (!args.includes("--offline")) {
    for (const [gw, url] of Object.entries(GOLDSKY)) {
      for (const [coll, kind] of [["gatewayBuys", "buy"], ["gatewaySells", "sell"], ["gatewayRedemptions", "redeem"]] as const) {
        try {
          const theirs = await goldskyCount(url, coll);
          const ours = (db.prepare("SELECT COUNT(*) n FROM events WHERE emitter=? AND kind=?").get(gw, kind) as any).n;
          add(`${kind} count vs subgraph ${gw.slice(0, 10)}`, ours >= theirs && ours - theirs <= 5, `subgraph ${theirs}, index ${ours}`);
        } catch (e) { add(`${kind} count vs subgraph ${gw.slice(0, 10)}`, false, `subgraph unreachable: ${(e as Error).message}`); }
      }
    }
  }

  // 4. Integrity of the index itself.
  const q = (s: string) => (db.prepare(s).get() as any).n as number;
  add("no events for unknown markets", q("SELECT COUNT(*) n FROM events e WHERE NOT EXISTS (SELECT 1 FROM markets m WHERE m.address=e.market)") === 0, "every event belongs to an indexed market");
  add("no events from the wrong gateway", q("SELECT COUNT(*) n FROM events e JOIN markets m ON m.address=e.market WHERE e.kind!='market_created' AND e.emitter!=m.gateway") === 0, "every trade came through the gateway paired with the market's factory");
  const meta = db.prepare("SELECT SUM(metadata_verified=1) ok, SUM(metadata_verified=0) bad, SUM(metadata_verified=-1) gone, SUM(metadata_verified IS NULL) pending, COUNT(*) n FROM markets").get() as any;
  add("market text matches on-chain hash", meta.bad <= Math.ceil(meta.n * 0.01), `${meta.ok}/${meta.n} match, ${meta.bad} differ, ${meta.gone} missing, ${meta.pending} not fetched yet`);

  // 5. The league record: every forecast is signed by its agent, sits in its batch, and every on-chain root matches.
  const lg = await import("./league/core.ts"), an = await import("./league/anchor.ts"), { verifyTypedData, hashTypedData } = await import("viem");
  const fs = db.prepare("SELECT * FROM league_forecasts ORDER BY id").all() as any[];
  if (fs.length) {
    let badSig = 0, badLeaf = 0;
    for (const f of fs) {
      const message = { market: f.market, probabilities: JSON.parse(f.probs), issuedAt: BigInt(f.issued_at), visibility: f.visibility, reasoningHash: f.reasoning_hash, receiptHash: f.receipt_hash };
      const ok = await verifyTypedData({ address: f.agent, domain: lg.DOMAIN, types: lg.TYPES, primaryType: "Forecast", message, signature: f.signature }).catch(() => false);
      if (!ok) badSig++;
      if (lg.leafOf(hashTypedData({ domain: lg.DOMAIN, types: lg.TYPES, primaryType: "Forecast", message }), f.agent) !== f.leaf) badLeaf++;
    }
    add("league forecasts are signed by their agents", badSig === 0 && badLeaf === 0, `${fs.length} forecasts, ${badSig} bad signatures, ${badLeaf} leaves that do not match their message`);
    const batches = db.prepare("SELECT * FROM league_batches ORDER BY id").all() as any[];
    let badRoot = 0, onChain = 0, chainMismatch = 0;
    for (const b of batches) {
      const leaves = (db.prepare("SELECT leaf FROM league_forecasts WHERE batch = ? ORDER BY id").all(b.id) as any[]).map((r) => r.leaf);
      if (leaves.length !== b.count || lg.merkleRoot(leaves).toLowerCase() !== b.root.toLowerCase()) badRoot++;
      if (b.anchored && an.anchoring().configured && b.contract === an.anchoring().contract) {
        onChain++;
        const [root, count] = (await an.agonPublic().readContract({ address: b.contract, abi: an.AGON_ABI, functionName: "batches", args: [BigInt(b.chain_batch)] })) as [string, number, bigint];
        if (root.toLowerCase() !== b.root.toLowerCase() || Number(count) !== b.count) chainMismatch++;
      }
    }
    add("league batches match their forecasts", badRoot === 0, `${batches.length} batches, ${badRoot} whose root does not rebuild from its forecasts`);
    add("league roots on chain match", chainMismatch === 0, onChain ? `${onChain} batches read back from the contract, ${chainMismatch} differ` : "no batch is on chain yet (the contract is not deployed), so there is nothing to compare");
    // Receipts: the stored text is still a valid REE receipt, it is the one the agent signed for, and every badge follows from signed re-runs.
    const rc = await import("./receipt.ts"), { keccak256, toHex } = await import("viem");
    const rs = db.prepare("SELECT r.*, f.receipt_hash signed, f.probs, f.market FROM league_receipts r JOIN league_forecasts f ON f.id = r.forecast_id").all() as any[];
    let broken = 0, unsigned = 0, wrongBadge = 0;
    for (const r of rs) {
      let parsed: any = null;
      try { parsed = JSON.parse(r.receipt); } catch { /* counted below */ }
      if (!parsed || !rc.validateReceipt(parsed).ok) broken++;
      if (!parsed || rc.receiptHashHex(parsed) !== r.receipt_hash || r.receipt_hash !== String(r.signed).toLowerCase()) unsigned++;
      if (lg.statusFromReruns(r.receipt_hash, JSON.parse(r.probs), JSON.parse((db.prepare("SELECT outcomes FROM markets WHERE address = ?").get(r.market) as any)?.outcomes ?? "[]")) !== r.status) wrongBadge++;
    }
    add("league receipts are intact and signed for", broken === 0 && unsigned === 0, `${rs.length} receipts, ${broken} that no longer validate, ${unsigned} whose hash is not the one in the signed forecast`);
    const vs = db.prepare("SELECT * FROM league_verifications").all() as any[];
    let badReport = 0;
    for (const v of vs) {
      const message = { receiptHash: v.receipt_hash, matched: !!v.matched, outputHash: v.output_hash, reeVersion: v.ree_version ?? "", issuedAt: BigInt(v.issued_at) };
      const ok = keccak256(toHex(v.output ?? "")) === v.output_hash && (await verifyTypedData({ address: v.verifier, domain: lg.DOMAIN, types: lg.TYPES, primaryType: "Verification", message, signature: v.signature }).catch(() => false));
      if (!ok) badReport++;
    }
    add("league re-run badges follow from signed reports", badReport === 0 && wrongBadge === 0, `${vs.length} re-run reports, ${badReport} with a bad signature or output, ${wrongBadge} badges that do not follow from the reports`);
    const before = (db.prepare("SELECT COUNT(*) n, COALESCE(SUM(points), 0) p FROM league_scores").get() as any);
    lg.scoreAll();
    const after = (db.prepare("SELECT COUNT(*) n, COALESCE(SUM(points), 0) p FROM league_scores").get() as any);
    add("league scores rebuild to the same values", before.n === after.n && Math.abs(before.p - after.p) < 1e-6, `${after.n} scores, total ${after.p.toFixed(4)} before and after a full re-score`);
  }

  const report = { at: new Date().toISOString(), passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length, checks };
  setMeta("verification", JSON.stringify(report));
  try { writeFileSync(join(dirname(DB_PATH), "verify.json"), JSON.stringify(report, null, 2)); } catch { /* read-only disk */ }
  console.log(`\n${report.passed} passed, ${report.failed} failed`);
  return report;
}
