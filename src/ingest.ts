import { db, tx, getCursor, setCursor } from "./db.ts";
import { network, LOG_SOURCE, lc } from "./config.ts";
import { EVENT_DEFS, decode, type RawLog, type Kind } from "./events.ts";
import { logsByTopic, headBlock } from "./sources/logs.ts";

export interface NewEvent { block: number; logIndex: number; ts: number | null; tx: string; emitter: string; kind: Kind; market: string; wallet: string | null; outcomeIdx: number | null; tokens: string | null; shares: string | null; extra: any }

const insEvent = db.prepare(`INSERT OR IGNORE INTO events(block,log_index,ts,tx,emitter,kind,market,wallet,outcome_idx,tokens,shares,extra) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
const insMarket = db.prepare(`INSERT OR IGNORE INTO markets(address,factory,mechanism,creator,implementation,created_block,created_ts,created_tx,outcome_count,liquidity_param,trading_fee,trading_deadline,earliest_resolve,settlement_deadline,metadata_uri,metadata_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const upContract = db.prepare(`INSERT INTO contracts(address,role,mechanism,first_block,last_block,first_ts,last_ts,n_events) VALUES(?,?,?,?,?,?,?,1)
  ON CONFLICT(address) DO UPDATE SET mechanism=COALESCE(contracts.mechanism,excluded.mechanism),
    first_block=MIN(contracts.first_block,excluded.first_block), last_block=MAX(contracts.last_block,excluded.last_block),
    first_ts=MIN(contracts.first_ts,excluded.first_ts), last_ts=MAX(contracts.last_ts,excluded.last_ts), n_events=contracts.n_events+1`);

export function store(log: RawLog): NewEvent | null {
  const d = decode(log);
  if (!d) return null;
  const { def, args } = d;
  const ts = log.timestamp ?? null;
  const market = lc(def.kind === "market_created" ? args.newMarketProxy : args.marketProxy);
  let wallet: string | null = null, outcomeIdx: number | null = null, tokens: string | null = null, shares: string | null = null, extra: any = null;

  switch (def.kind) {
    case "market_created": {
      wallet = lc(args.deployer);
      const c = args.newMarketConfig, m = args.newMarketMetadata;
      insMarket.run(market, log.address, def.mechanism!, wallet, lc(args.implementation), log.blockNumber, ts, log.transactionHash,
        c ? Number(c.outcomeCount) : null, c ? String(c.b) : null, c ? Number(c.tradingFee) / 1e18 : null,
        c ? Number(c.tradingDeadline) : null, c ? Number(c.earliestResolveTime) : null, c ? Number(c.settlementDeadline) : null,
        m.uri, m.uriContentHash);
      break;
    }
    case "buy": wallet = lc(args.buyer); outcomeIdx = Number(args.outcomeIdx); tokens = String(args.tokensIn); shares = String(args.sharesOut); break;
    case "sell": wallet = lc(args.seller); outcomeIdx = Number(args.outcomeIdx); tokens = String(args.tokensOut); shares = String(args.sharesIn); break;
    case "redeem": wallet = lc(args.redeemer); tokens = String(args.tokensOut); shares = String(args.sharesIn); break;
    case "liquidate":
      wallet = lc(args.liquidator); tokens = String(args.totalTokensOut);
      extra = { outcomeIndices: args.outcomeIndices.map(Number), sharesIn: args.sharesIn.map(String) };
      break;
    case "settled":
      outcomeIdx = Number(args.winningOutcomeIdx);
      if (args.refund !== undefined) extra = { creatorReward: String(args.marketCreatorReward), refund: String(args.refund), creatorFeesCut: String(args.marketCreatorTradingFeesCut) };
      break;
    case "resolution_requested": wallet = lc(args.keeper); break;
    case "failed": break;
  }
  if (args.newExpSum !== undefined) extra = { exp: String(args.outcomeNewExp), expSum: String(args.newExpSum) };

  const r = insEvent.run(log.blockNumber, log.logIndex, ts, log.transactionHash, log.address, def.kind, market, wallet, outcomeIdx, tokens, shares, extra ? JSON.stringify(extra) : null);
  if (!r.changes) return null;
  upContract.run(log.address, def.role, def.mechanism ?? null, log.blockNumber, log.blockNumber, ts, ts);
  return { block: log.blockNumber, logIndex: log.logIndex, ts, tx: log.transactionHash, emitter: log.address, kind: def.kind, market, wallet, outcomeIdx, tokens, shares, extra };
}

/** Overlap re-read on every pass so a lagging explorer or a short reorg cannot leave a hole. */
const OVERLAP = 60;

export async function syncLogs(opts: { source?: "explorer" | "rpc"; log?: (s: string) => void } = {}): Promise<NewEvent[]> {
  const source = opts.source ?? LOG_SOURCE;
  const head = await headBlock();
  const fresh: NewEvent[] = [];
  for (const def of EVENT_DEFS) {
    const key = `${source}:${def.topic0}`;
    const from = Math.max(network.startBlock, (getCursor(key) ?? network.startBlock) - OVERLAP);
    let n = 0;
    for await (const batch of logsByTopic(def.topic0, from, head, source)) {
      tx(() => { for (const l of batch) { const e = store(l); if (e) { fresh.push(e); n++; } } });
    }
    setCursor(key, head);
    if (n && opts.log) opts.log(`  ${def.name}${def.mechanism ? ` (${def.mechanism})` : ""}: +${n}`);
  }
  setCursor("head", head);
  fresh.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return fresh;
}
