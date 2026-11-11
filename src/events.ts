import { parseAbi, toEventSelector, getAbiItem, decodeEventLog, type AbiEvent } from "viem";

/**
 * Every event shape Delphi has shipped on the Gensyn chain, across three contract generations.
 * Tripod finds contracts by these signatures, so a new deployment that reuses a known shape is
 * picked up without anyone editing an address list.
 */
export const EVENTS_ABI = parseAbi([
  // Factories
  "event NewMarketProxy(address indexed deployer, address indexed implementation, address newMarketProxy, (string uri, bytes32 uriContentHash) newMarketMetadata)",
  "event NewMarketProxy(address indexed deployer, address indexed implementation, address newMarketProxy, (uint256 outcomeCount, uint256 b, uint256 tradingFee, uint256 tradingDeadline, uint256 earliestResolveTime, uint256 settlementDeadline) newMarketConfig, (string uri, bytes32 uriContentHash) newMarketMetadata)",
  // Pari-mutuel gateways (first two generations)
  "event GatewayBuy(address indexed marketProxy, address indexed buyer, uint256 indexed outcomeIdx, uint256 tokensIn, uint256 sharesOut)",
  "event GatewaySell(address indexed marketProxy, address indexed seller, uint256 indexed outcomeIdx, uint256 sharesIn, uint256 tokensOut)",
  // LMSR gateway (third generation) reports the pricing state after each trade
  "event GatewayBuy(address indexed marketProxy, address indexed buyer, uint256 indexed outcomeIdx, uint256 tokensIn, uint256 sharesOut, uint256 outcomeNewExp, uint256 newExpSum)",
  "event GatewaySell(address indexed marketProxy, address indexed seller, uint256 indexed outcomeIdx, uint256 sharesIn, uint256 tokensOut, uint256 outcomeNewExp, uint256 newExpSum)",
  // Shared
  "event GatewayRedemption(address indexed marketProxy, address indexed redeemer, uint256 sharesIn, uint256 tokensOut)",
  "event GatewayLiquidation(address indexed marketProxy, address indexed liquidator, uint256[] outcomeIndices, uint256[] sharesIn, uint256 totalTokensOut)",
  // Resolution
  "event GatewayWinnerSubmitted(address indexed marketProxy, uint256 winningOutcomeIdx, uint256 marketCreatorReward, uint256 refund, uint256 marketCreatorTradingFeesCut)",
  "event GatewayMarketSettled(address indexed marketProxy, uint256 winningOutcomeIdx, uint256 marketCreatorReward, uint256 refund, uint256 marketCreatorTradingFeesCut)",
  "event GatewayMarketSettled(address indexed marketProxy, uint256 winningOutcomeIdx)",
  "event GatewayMarketFailed(address indexed marketProxy)",
  "event MarketResolutionRequested(address indexed marketProxy, address indexed keeper)",
]);

export type Kind =
  | "market_created" | "buy" | "sell" | "redeem" | "liquidate"
  | "settled" | "failed" | "resolution_requested";

export interface EventDef { topic0: string; name: string; kind: Kind; role: "factory" | "gateway"; mechanism?: "lmsr" | "dpm"; item: AbiEvent }

const kindOf: Record<string, Kind> = {
  NewMarketProxy: "market_created", GatewayBuy: "buy", GatewaySell: "sell", GatewayRedemption: "redeem",
  GatewayLiquidation: "liquidate", GatewayWinnerSubmitted: "settled", GatewayMarketSettled: "settled",
  GatewayMarketFailed: "failed", MarketResolutionRequested: "resolution_requested",
};

export const EVENT_DEFS: EventDef[] = (EVENTS_ABI as readonly AbiEvent[]).map((item) => {
  const inputs = item.inputs.map((i) => i.name);
  let mechanism: "lmsr" | "dpm" | undefined;
  if (item.name === "NewMarketProxy") mechanism = inputs.includes("newMarketConfig") ? "lmsr" : "dpm";
  else if (item.name === "GatewayBuy" || item.name === "GatewaySell") mechanism = inputs.includes("newExpSum") ? "lmsr" : "dpm";
  else if (item.name === "GatewayWinnerSubmitted") mechanism = "dpm";
  else if (item.name === "GatewayMarketSettled") mechanism = inputs.includes("refund") ? "dpm" : "lmsr";
  return {
    topic0: toEventSelector(item), name: item.name, kind: kindOf[item.name],
    role: item.name === "NewMarketProxy" ? "factory" : "gateway", mechanism, item,
  };
});

export const DEF_BY_TOPIC = new Map(EVENT_DEFS.map((d) => [d.topic0, d]));

export interface RawLog { address: string; topics: string[]; data: string; blockNumber: number; logIndex: number; transactionHash: string; timestamp?: number }

export function decode(log: RawLog) {
  const def = DEF_BY_TOPIC.get(log.topics[0]);
  if (!def) return null;
  try {
    const { args } = decodeEventLog({ abi: [def.item], data: log.data as `0x${string}`, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
    return { def, args: args as Record<string, any> };
  } catch {
    return null; // same topic0 from an unrelated contract with a different layout
  }
}

void getAbiItem;
