import { createHash } from "node:crypto";

/**
 * Provable forecasts.
 *
 * A forecast may carry a receipt from REE, Gensyn's reproducible inference tool. The receipt names the
 * model revision, the exact prompt and the exact output, and anyone can re-run it. This module holds the
 * rules that tie such a receipt to one Delphi market and one set of probabilities:
 *
 *   1. the prompt follows the published template and names this market and its on-chain text hash;
 *   2. the probabilities claimed in the forecast are the ones a fixed parser reads from the model output;
 *   3. decoding was deterministic, so the output is a function of the prompt alone.
 *
 * `validateReceipt` recomputes the receipt's own hashes; re-running it (`verify`) is REE's job. See docs/AGON.md.
 */

export const TEMPLATE = "AGON FORECAST v1";

export interface MarketText { address: string; metadataHash: string; question: string; outcomes: string[]; criteria: string }
export interface ResearchItem { url?: string; fetchedAt?: string; sha256?: string; text: string }

const sha256hex = (s: string) => "0x" + createHash("sha256").update(s, "utf8").digest("hex");

/** Canonical research pack: sorted keys, no whitespace, so its hash is stable across implementations. */
export function packHash(research: ResearchItem[]): string {
  const canon = JSON.stringify(research.map((r) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)))));
  return sha256hex(canon);
}

/** `directive` is an optional last line published per model on the strict tier, e.g. "/no_think" to switch off Qwen3's thinking mode. */
export function buildPrompt(m: MarketText, research: ResearchItem[], directive?: string): string {
  return [
    TEMPLATE,
    `market: ${m.address.toLowerCase()}`,
    `text_sha256: ${m.metadataHash.toLowerCase()}`,
    `question: ${m.question}`,
    "outcomes: " + m.outcomes.map((o, i) => `${i}=${o}`).join(", "),
    "rules:",
    m.criteria.trim(),
    `research_pack_sha256: ${packHash(research)}`,
    "research:",
    ...research.map((r) => `- ${[r.url, r.fetchedAt, r.sha256].filter(Boolean).join(" | ")}${r.url ? " | " : ""}${r.text}`),
    "",
    "Task: estimate the probability of each outcome as whole percentages that add up to 100.",
    "Reply with exactly one line in this form and nothing else:",
    "FORECAST: " + m.outcomes.map((o) => `${o}=<percent>`).join("; "),
    ...(directive ? [directive] : []),
  ].join("\n");
}

/** Read `FORECAST: A=62; B=38` from model output. Returns probabilities in outcome order, or a reason it failed. */
export function parseForecast(output: string, outcomes: string[]): { probs: number[] } | { error: string } {
  // Thinking models print their reasoning first; the forecast is the last line that matches.
  // Drop end-of-turn markers such as <|im_end|> that some models append to the final line.
  const lines = output.replace(/<\|[^|>]*\|>/g, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^FORECAST\s*:/i.test(l));
  if (!lines.length) return { error: "no FORECAST line in the model output" };
  const body = lines[lines.length - 1].replace(/^FORECAST\s*:/i, "");
  const found = new Map<string, number>();
  for (const part of body.split(";")) {
    const m = part.match(/^\s*(.+?)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*%?\s*$/);
    if (!m) return { error: `cannot read "${part.trim()}"` };
    found.set(m[1].toLowerCase(), Number(m[2]));
  }
  const pct: number[] = [];
  for (const o of outcomes) {
    const v = found.get(o.toLowerCase());
    if (v === undefined) return { error: `no value for outcome "${o}"` };
    pct.push(v);
  }
  if (found.size !== outcomes.length) return { error: "extra or duplicate outcomes in the FORECAST line" };
  const sum = pct.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.5) return { error: `percentages add up to ${sum}, not 100` };
  // Same clipping the scoreboard applies to every forecast.
  const clipped = pct.map((p) => Math.min(99, Math.max(1, p)) / 100);
  const s = clipped.reduce((a, b) => a + b, 0);
  return { probs: clipped.map((p) => Math.round((p / s) * 1e6) / 1e6) };
}

/** REE receipt, format 2.x, as written by `gensyn-sdk` 0.8. */
export interface Receipt {
  version: string; ree_version?: string;
  model: { name: string; commit_hash: string; config_hash: string };
  input: { prompt: string; prompt_hash: string; tools: unknown; tools_hash: string; parameters: Record<string, any>; parameters_hash: string };
  output: { tokens_hash: string; token_count: number; finish_reason: string; text_output: string };
  execution?: Record<string, unknown>;
  hashes: { receipt_hash: string; execution_hash?: string };
}

const sha = (b: string | Buffer) => "sha256:" + createHash("sha256").update(b).digest("hex");
/** Sorted keys, no whitespace: the canonical JSON the REE SDK hashes. */
function canonical(o: unknown): string {
  if (o === null || typeof o !== "object") return typeof o === "number" && Object.is(o, -0) ? "0" : pyJson(o);
  if (Array.isArray(o)) return "[" + o.map(canonical).join(",") + "]";
  return "{" + Object.keys(o as object).sort().map((k) => JSON.stringify(k) + ":" + canonical((o as any)[k])).join(",") + "}";
}
/** Python's json.dumps writes whole-number floats as `1.0`; the receipt keeps them that way, so mirror it for known float fields. */
const FLOAT_FIELDS = new Set(["temperature", "top_p", "min_p", "repetition_penalty"]);
function pyJson(v: unknown): string { return JSON.stringify(v); }
function canonicalParams(o: Record<string, unknown>): string {
  return "{" + Object.keys(o).sort().map((k) => {
    const v = o[k];
    const body = typeof v === "number" && FLOAT_FIELDS.has(k) && Number.isInteger(v) ? v.toFixed(1) : canonical(v);
    return JSON.stringify(k) + ":" + body;
  }).join(",") + "}";
}
const normText = (t: string) => t.normalize("NFC").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n");

const HASHED_PARAMS = ["max_new_tokens", "temperature", "top_k", "top_p", "min_p", "repetition_penalty", "seed", "operation_set", "rand_algorithm", "do_sample",
  "eos_token", "short_circuit_length", "short_circuit_token", "use_kv_cache", "pad_token", "vocab_size"];

/**
 * The same four checks as REE's `validate`, recomputed here so the scoreboard needs no container for them.
 * Ported from the MIT-licensed REE SDK (gensyn_sdk/receipt.py). Covers receipt format 2.0.x.
 *
 * What this does NOT establish: `validate` passes a receipt whose `text_output` was edited, and a receipt
 * forged for another prompt with its hashes recomputed. Only the token ids are committed to, and only a
 * re-run proves the tokens came from the model. See `bindOutput` and docs/AGON.md.
 */
export function validateReceipt(r: Receipt): { ok: boolean; failed: string[] } {
  const failed: string[] = [];
  const P = r.input.parameters ?? {};
  const rel: Record<string, unknown> = {};
  for (const k of HASHED_PARAMS) rel[k] = k === "repetition_penalty" ? P[k] ?? 1.0 : k === "rand_algorithm" ? P[k] ?? "default" : k === "operation_set" ? String(P[k]) : P[k] ?? null;
  if ("enable_thinking" in P) rel["enable_thinking"] = P["enable_thinking"];
  if ("export_device" in P) rel["export_device"] = P["export_device"];
  if (sha(Buffer.from(normText(r.input.prompt), "utf8")) !== r.input.prompt_hash) failed.push("prompt_hash");
  if (sha(canonical(r.input.tools ?? null)) !== r.input.tools_hash) failed.push("tools_hash");
  if (sha(canonicalParams(rel)) !== r.input.parameters_hash) failed.push("parameters_hash");
  const parts = [r.model.commit_hash, r.model.config_hash, r.input.prompt_hash, r.input.tools_hash, r.input.parameters_hash, r.output.tokens_hash];
  if (r.hashes.execution_hash) parts.push(r.hashes.execution_hash);
  if (sha(parts.join("|")) !== r.hashes.receipt_hash) failed.push("receipt_hash");
  return { ok: failed.length === 0, failed };
}

/** The receipt commits to token ids, not text. Given the ids, check they are the committed ones. */
export const tokensMatch = (r: Receipt, tokens: number[]) => sha("[" + tokens.join(",") + "]") === r.output.tokens_hash;

export interface ReceiptCheck { ok: boolean; reasons: string[]; model?: string; revision?: string; reeVersion?: string; probs?: number[] }

/**
 * The scoreboard's own conditions for tying a receipt to one market and one probability vector.
 * `outputText` must come from a source the scoreboard trusts: its own re-run, or the committed token ids
 * decoded with the model's tokenizer. Never from `text_output` alone.
 */
export function checkReceipt(r: Receipt, m: MarketText, claimed: number[], outputText: string, research?: ResearchItem[], directive?: string): ReceiptCheck {
  const reasons: string[] = [];
  const v = validateReceipt(r);
  if (!v.ok) reasons.push("receipt hashes do not match: " + v.failed.join(", "));
  const prompt = r.input.prompt;
  const line = (k: string) => prompt.split("\n").find((l) => l.startsWith(k + ": "))?.slice(k.length + 2).trim();
  if (!prompt.startsWith(TEMPLATE + "\n")) reasons.push("prompt does not use the published template");
  if (line("market") !== m.address.toLowerCase()) reasons.push("prompt names a different market");
  if (line("text_sha256") !== m.metadataHash.toLowerCase()) reasons.push("prompt carries a different market text hash");
  if (research && prompt !== buildPrompt(m, research, directive)) reasons.push("prompt is not the strict-tier prompt for this market");
  const P = r.input.parameters ?? {};
  if (P.do_sample !== false) reasons.push("decoding was sampled, so the output is not a function of the prompt alone");
  if (String(P.operation_set) !== "reproducible") reasons.push("the run did not use REE's reproducible operation set");
  if (r.output.finish_reason !== "eos_token") reasons.push("the model was cut off before it finished");
  const parsed = parseForecast(outputText, m.outcomes);
  let probs: number[] | undefined;
  if ("error" in parsed) reasons.push("output: " + parsed.error);
  else {
    probs = parsed.probs;
    if (claimed.length !== probs.length || claimed.some((c, i) => Math.abs(c - probs![i]) > 1e-6)) reasons.push("claimed probabilities differ from the model output");
  }
  return { ok: reasons.length === 0, reasons, model: r.model.name, revision: r.model.commit_hash, reeVersion: r.ree_version, probs };
}
