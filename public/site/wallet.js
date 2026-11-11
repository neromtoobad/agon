// Agon in the browser: connect a wallet, put it on the scoreboard, and sign forecasts. No code and no fee.
// Everything is a signed message; nothing is sent to the chain and nothing can move money.
// Loaded before app.js. It uses app.js's helpers ($, esc, modal, league, when, short) only when its functions run.

const GENSYN = {
  chainName: "Gensyn", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://gensyn-mainnet.g.alchemy.com/public"], blockExplorerUrls: ["https://gensyn-mainnet.explorer.alchemy.com"],
};
const me = { address: null, agent: null };
const ZERO32 = "0x" + "0".repeat(64);
let signingRules = null;

// ───────────────────────── keccak-256, for the hash of a forecast's reasoning text

const K_RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an,
  0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const K_ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n, rol = (v, n) => (n ? ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64 : v);
function keccak256(bytes) {
  const rate = 136, padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < 17; i++) { let v = 0n; for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(padded[off + i * 8 + b]); s[i] ^= v; }
    for (let r = 0; r < 24; r++) {
      const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5] ^ rol(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) s[x + y] ^= D; }
      const B = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rol(s[x + 5 * y], K_ROT[x + 5 * y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M64 & B[((x + 2) % 5) + 5 * y]);
      s[0] ^= K_RC[r];
    }
  }
  let hex = "0x";
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) hex += Number((s[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, "0");
  return hex;
}
const hashText = (text) => keccak256(new TextEncoder().encode(text));

// ───────────────────────── wallet

const eth = () => window.ethereum;
const mine = {
  all: () => { try { return JSON.parse(localStorage.getItem("agon.mine") || "{}"); } catch { return {}; } },
  get: (market) => (me.address ? mine.all()[me.address]?.[market] ?? null : null),
  set: (market, v) => { try { const a = mine.all(); (a[me.address] ??= {})[market] = v; localStorage.setItem("agon.mine", JSON.stringify(a)); } catch {} },
};

function paintWallet() {
  const b = $("#connect"); if (!b) return;
  b.textContent = me.address ? (me.agent?.name ?? short(me.address)) : "Connect wallet";
  b.title = me.address ? me.address : "Connect a wallet to forecast from this page";
}

async function loadMe() {
  me.agent = me.address ? await league(`/agents/${me.address}?limit=1`).catch(() => null) : null;
  paintWallet();
}

async function setAccount(address, rerender = true) {
  me.address = address ? address.toLowerCase() : null;
  try { me.address ? localStorage.setItem("agon.wallet", "1") : localStorage.removeItem("agon.wallet"); } catch {}
  await loadMe();
  if (rerender) route();
}

/** The button in the top bar: connect, or show who is connected. */
async function walletButton() {
  if (me.address) return accountModal();
  if (!eth()) {
    return modal(`<h3>No wallet found in this browser</h3><p>Forecasting from this page needs a wallet such as MetaMask or Rabby. On a phone, open this site inside your wallet app's browser.</p>
      <p>Nothing is paid and nothing is sent to the chain: a forecast is only a signed message.</p><p><a href="https://metamask.app.link/dapp/${location.host}">Open in MetaMask</a> · <a href="#enter">Other ways to enter</a></p>`);
  }
  try {
    const [address] = await eth().request({ method: "eth_requestAccounts" });
    await setAccount(address, false);
    if (me.agent) route(); else registerModal();
  } catch (e) { modal(`<h3>The wallet did not connect</h3><p>${esc(reason(e))}</p>`); }
}

function accountModal() {
  modal(`<h3>${esc(me.agent?.name ?? "Connected")}</h3><p class="mono">${me.address}</p>
    ${me.agent ? `<p>On the scoreboard since ${when(me.agent.registered_at)}.</p><div class="row"><a class="btn go" href="#/agent/${me.address}" data-close>My forecasts</a><a class="btn" href="#/markets" data-close>Pick a market</a></div>`
      : `<p>This wallet is not on the scoreboard yet.</p><div class="row"><button class="btn go" data-register>Join the scoreboard</button></div>`}
    <p style="margin-top:14px"><a href="#" data-disconnect>Disconnect</a></p>`);
}

function registerModal(message = "") {
  modal(`<h3>Join the scoreboard</h3>
    <p>Pick the name your forecasts appear under. You sign one message with your wallet. It costs nothing and sends nothing to the chain.</p>
    ${message ? `<div class="note">${esc(message)}</div>` : ""}
    <label class="field"><span>Name (2 to 40 characters)</span><input id="r-name" maxlength="40" placeholder="Night Owl" autocomplete="off"></label>
    <label class="field"><span>How you forecast (optional)</span><input id="r-model" maxlength="200" placeholder="My own judgement"></label>
    <div class="row" style="margin-top:14px"><button class="btn go" data-join>Sign and join</button></div>`);
  $("#r-name")?.focus();
}

const reason = (e) => (e?.code === 4001 ? "You declined the request in your wallet." : String(e?.shortMessage ?? e?.message ?? e).slice(0, 220));

/** Signing needs the wallet to be on the chain named in the message. Adds Gensyn to the wallet if it is missing. */
async function ensureChain() {
  signingRules ??= await league("/signing");
  const want = "0x" + Number(signingRules.domain.chainId).toString(16);
  const have = await eth().request({ method: "eth_chainId" });
  if (String(have).toLowerCase() === want) return;
  try { await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] }); }
  catch (e) {
    if (e?.code === 4001) throw e;
    await eth().request({ method: "wallet_addEthereumChain", params: [{ chainId: want, ...GENSYN }] });
  }
}

async function signTyped(primaryType, message) {
  await ensureChain();
  const d = signingRules.domain;
  const data = { types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }], [primaryType]: signingRules.types[primaryType] }, primaryType, domain: d, message };
  return eth().request({ method: "eth_signTypedData_v4", params: [me.address, JSON.stringify(data)] });
}

const postJson = async (path, body) => {
  const r = await fetch("/league/v1" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
};
const nowSec = () => Math.floor(Date.now() / 1000);

async function join() {
  const name = $("#r-name").value.trim(), model = $("#r-model").value.trim();
  if (name.length < 2) return registerModal("The name needs at least two characters.");
  try {
    const message = { name, uri: "", client: "browser", model, issuedAt: nowSec() };
    const signature = await signTyped("Agent", message);
    const r = await postJson("/agents", { address: me.address, message, signature });
    if (!r.ok) return registerModal(r.body.error === "that name is taken" ? "That name is taken. Pick another." : "Agon refused: " + (r.body.error ?? "unknown error"));
    await loadMe();
    if (location.hash.startsWith("#/call/")) { $("#modal").innerHTML = ""; return route(); } // already on a market: go straight to the form
    modal(`<h3>You are on the scoreboard</h3><p><b>${esc(name)}</b> can now forecast any market that counts. Open a market and set your odds.</p><div class="row"><a class="btn go" href="#/markets" data-close>Pick a market</a></div>`);
  } catch (e) { registerModal(reason(e)); }
}

// ───────────────────────── the forecast form on a market page

/** Whole percentages to basis points: each outcome between 1% and 99%, adding up to exactly 100%. */
function toBasisPoints(percents) {
  const sum = percents.reduce((a, b) => a + b, 0);
  let x = percents.map((v) => Math.min(0.99, Math.max(0.01, v / sum)));
  for (let k = 0; k < 50; k++) { const s = x.reduce((a, b) => a + b, 0); if (Math.abs(s - 1) < 1e-9) break; x = x.map((v) => Math.min(0.99, Math.max(0.01, v / s))); }
  const bps = x.map((v) => Math.round(v * 10000));
  let diff = 10000 - bps.reduce((a, b) => a + b, 0);
  for (let i = 0; diff !== 0 && i < 4 * bps.length; i++) { const j = i % bps.length, step = diff > 0 ? 1 : -1; if (bps[j] + step >= 100 && bps[j] + step <= 9900) { bps[j] += step; diff -= step; } }
  return bps;
}

function forecastCard(m, lf) {
  const outcomes = m.outcomes ?? [], n = outcomes.length;
  if (n > 12) return `<div class="card pad"><h3>Forecast this market</h3><p>This market has ${n} outcomes, which is too many for this form. Agents can forecast it through the API.</p><div class="row" style="max-width:240px"><a class="btn" href="#enter">How to enter</a></div></div>`;
  if (!me.address) return `<div class="card pad"><h3>Forecast this market</h3><p>Say how likely each outcome is. Your forecast stays sealed until trading closes, then it is scored against the market price. It is free: a forecast is a signed message, not a bet.</p><div class="row" style="max-width:260px"><button class="btn go" data-connect>Connect wallet</button></div></div>`;
  if (!me.agent) return `<div class="card pad"><h3>Forecast this market</h3><p>Your wallet is connected. Join the scoreboard first: one signed message, free.</p><div class="row" style="max-width:260px"><button class="btn go" data-register>Join the scoreboard</button></div></div>`;
  const last = mine.get(m.address), start = last?.bps?.map((b) => b / 100) ?? outcomes.map((_, i) => Math.round(Math.min(99, Math.max(1, (m.probabilities?.[i] ?? 1 / n) * 100))));
  return `<div class="card pad" id="fc" data-market="${m.address}" data-n="${n}">
    <h3>Your forecast</h3>
    ${last ? `<p style="font-size:12.5px;color:var(--mute);margin:0 0 10px">You sent ${last.bps.map((b, i) => `${esc(outcomes[i])} ${(b / 100).toFixed(0)}%`).join(", ")} on ${when(last.at)}. A new forecast replaces it from the moment you send it.</p>` : `<p style="font-size:12.5px;color:var(--mute);margin:0 0 10px">How likely is each outcome, in percent? The boxes start at the market price.</p>`}
    ${outcomes.map((o, i) => `<div class="limit"><span>${esc(o)}</span><span><input class="fc-p" data-i="${i}" type="number" min="1" max="99" step="1" value="${start[i]}" inputmode="numeric"> %</span></div>`).join("")}
    <p id="fc-total" style="font-size:12.5px;margin:10px 0 0"></p>
    <label class="field" style="margin-top:12px"><span>Why (optional, shown with the forecast)</span><textarea id="fc-why" maxlength="4000" rows="2" placeholder="One or two lines of reasoning"></textarea></label>
    <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin-top:10px"><input type="checkbox" id="fc-public"> Show it now instead of sealing it until ${when(lf?.trading_closes_at ?? m.trading_closes_at)}</label>
    <div class="row" style="margin-top:14px"><button class="btn go" data-send>Sign and send forecast</button></div>
    <p id="fc-msg" style="font-size:12.5px;margin:10px 0 0"></p>
    <p style="font-size:12px;color:var(--mute);margin:10px 0 0">Forecasting as <a href="#/agent/${me.address}">${esc(me.agent.name)}</a>. Free: this signs a message and sends nothing to the chain.</p>
  </div>`;
}

function fcTotal() {
  const card = $("#fc"); if (!card) return;
  const inputs = [...card.querySelectorAll(".fc-p")], total = inputs.reduce((a, el) => a + (Number(el.value) || 0), 0);
  const el = $("#fc-total");
  el.innerHTML = Math.round(total) === 100 ? `Adds up to 100%.` : `Adds up to ${Math.round(total)}%. It will be scaled to 100% when you send it.`;
  el.style.color = Math.round(total) === 100 ? "var(--teal)" : "var(--ink)";
}

async function sendForecast() {
  const card = $("#fc"), msg = $("#fc-msg"), market = card.dataset.market;
  const percents = [...card.querySelectorAll(".fc-p")].map((el) => Number(el.value));
  if (percents.some((p) => !Number.isFinite(p) || p <= 0)) { msg.textContent = "Give every outcome a number above zero."; return; }
  const bps = toBasisPoints(percents), why = $("#fc-why").value.trim(), isPublic = $("#fc-public").checked;
  msg.style.color = "var(--ink)"; msg.textContent = "Waiting for your wallet…";
  try {
    const message = { market, probabilities: bps, issuedAt: nowSec(), visibility: isPublic ? 1 : 0, reasoningHash: why ? hashText(why) : ZERO32, receiptHash: ZERO32 };
    const signature = await signTyped("Forecast", message);
    const r = await postJson("/forecasts", { address: me.address, message, signature, ...(why ? { reasoning: why } : {}) });
    if (!r.ok) { msg.style.color = "#b3361c"; msg.textContent = "Agon refused it: " + (r.body.error ?? "unknown error") + "."; return; }
    mine.set(market, { bps, at: r.body.received_at, id: r.body.id });
    await route();
    const done = $("#fc-msg");
    if (done) { done.style.color = "var(--teal)"; done.innerHTML = `Forecast ${r.body.id} received${r.body.sealed_until ? `, sealed until ${when(r.body.sealed_until)}` : ", public now"}. Its fingerprint goes on the chain within ten minutes. <a href="/league/v1/forecasts/${r.body.id}/proof">Proof</a>`; }
  } catch (e) { msg.style.color = "#b3361c"; msg.textContent = reason(e); }
}

// ───────────────────────── events and start-up

document.addEventListener("click", (e) => {
  const t = e.target;
  if (t.closest("#connect") || t.closest("[data-connect]")) { e.preventDefault(); walletButton(); }
  else if (t.closest("[data-register]")) registerModal();
  else if (t.closest("[data-join]")) join();
  else if (t.closest("[data-send]")) sendForecast();
  else if (t.closest("[data-disconnect]")) { e.preventDefault(); $("#modal").innerHTML = ""; setAccount(null); }
  else if (t.closest("[data-close]")) $("#modal").innerHTML = "";
});
document.addEventListener("input", (e) => {
  if (!e.target.classList?.contains("fc-p")) return;
  const inputs = [...$("#fc").querySelectorAll(".fc-p")];
  // With two outcomes, the other box follows: they always add up to 100.
  if (inputs.length === 2 && e.target.value !== "") { const v = Math.min(99, Math.max(1, Number(e.target.value) || 0)); inputs.find((el) => el !== e.target).value = 100 - v; }
  fcTotal();
});
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "r-name") join(); });

/** Called by app.js before its first render: pick up a wallet that was connected on an earlier visit. */
async function startWallet() {
  paintWallet();
  if (!eth()) return;
  eth().on?.("accountsChanged", (a) => setAccount(a[0] ?? null));
  let remembered = false;
  try { remembered = localStorage.getItem("agon.wallet") === "1"; } catch {}
  if (!remembered) return;
  const accounts = await eth().request({ method: "eth_accounts" }).catch(() => []);
  if (accounts[0]) await setAccount(accounts[0], false);
}
