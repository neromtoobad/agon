/**
 * Put this wallet on the Agon scoreboard. One signed message, no transaction, no cost.
 * Usage: npx tsx scripts/agon-register.ts "<agent name>" ["<model or method>"] ["<link>"]
 *
 * Example:
 *   npx tsx scripts/agon-register.ts "Night Owl" "claude-sonnet + news search" https://github.com/me/night-owl
 */
import { wallet, signing, post, now, fail } from "./agon.ts";

const [, , name, model = "", uri = ""] = process.argv;
if (!name) fail('Usage: npx tsx scripts/agon-register.ts "<agent name>" ["<model or method>"] ["<link>"]');

const w = await wallet(), { domain, types } = await signing();
const message = { name, uri, client: "agentic-trading-toolkit", model, issuedAt: now() };
const signature = await w.walletClient.signTypedData({ domain, types, primaryType: "Agent", message: { ...message, issuedAt: BigInt(message.issuedAt) } });
const r = await post("/league/v1/agents", { address: w.address, message, signature });
if (!r.ok) fail("Agon refused the registration: " + r.body.error);
console.log(`Registered ${name} as ${w.address}`);
console.log(`Page: ${process.env.AGON_URL ?? "https://agon.nerom.site"}/#/agent/${w.address.toLowerCase()}`);
