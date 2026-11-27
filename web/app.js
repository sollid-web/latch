// Latch web app: Home, Create, My vaults, Chip, Activity, Safety (hash routes, one file, no server).
// Bundled into public/index.html by scripts/build-web.mjs (esbuild).
import { parseUnits, formatUnits, getAddress, isAddress } from 'viem';
import {
  C, U6, E18, MAX, ZERO, pub, FACTORY1, VAULT1, FACTORY2, VAULT2, ERC20, WOKB_ABI, POOL, PROC, S, hooks,
  connect, disconnect, restoreSession, choose, closePicker, cancelWc, browserWallets, hasWalletConnect, isMobile,
  send, addFunds, declined, plain, tradesOf, okxAppLink, okxWalletLink,
  esc, usd, okb, short, link, when, spacingText
} from './core.js';
import { evalChip, pack, MODES, DEPTHS, depthWord, VOLS, SAFETY, curve, depthOf, GATE_COUNT, SAFE } from './strategy.js';

const HAS2 = !!C.factory2;
const CID2 = C.circuit2Id ?? 2;
Object.assign(S, {
  net: null, v1: [], v2: [], hist: {}, feed: null, loading: false, refreshing: false, feedBusy: false,
  c: null, dialog: null, mins: { buy: U6, sell: 10n ** 16n },
  x: { depth: 3, vol: 0, mode: 2, dir: 0, safety: SAFE, live: null }, // chip explorer input
  t: { dir: 0, mode: 2, base: '2', ref: '', limit: '', mkt: null, live: null } // Try it (no wallet)
});

/* ================================================================ data */

const retry = async (fn, n = 3) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n - 1) throw e; await new Promise((r) => setTimeout(r, 700 * (i + 1))); } } };
async function readMarket() {
  try {
    const [s0, t0] = await Promise.all([
      retry(() => pub.readContract({ address: C.pool, abi: POOL, functionName: 'slot0' })),
      retry(() => pub.readContract({ address: C.pool, abi: POOL, functionName: 'token0' }))
    ]);
    const raw = Math.pow(1.0001, Number(s0[1]));
    S.price = t0.toLowerCase() === C.usdt.toLowerCase() ? 1e12 / raw : raw * 1e12;
  } catch {
    // Fall back to the 30-minute average a vault reports (same pool), so the price never stays blank.
    try {
      const first = HAS2 ? (await pub.readContract({ address: C.factory2, abi: FACTORY2, functionName: 'vaultsPage', args: [0n, 1n] }))[0] : null;
      S.price = first ? Number(await pub.readContract({ address: first, abi: VAULT2, functionName: 'twapPrice' })) / 1e6 : (S.price ?? null);
    } catch { /* keep the last value */ }
  }
  if (HAS2 && !S.treasury) {
    try {
      const [t, k, mb, ms] = await Promise.all(['treasury', 'hostedKeeper', 'minBuy', 'minSell'].map((f) => pub.readContract({ address: C.factory2, abi: FACTORY2, functionName: f })));
      S.treasury = t; S.hostedKeeper = k; S.mins = { buy: mb, sell: ms };
    } catch { /* later */ }
  }
}

/** Live market exactly as a vault sees it: Uniswap's 30-minute average and how far the live price is from it. */
async function readLive() {
  const [s0, t0, obs] = await Promise.all([
    retry(() => pub.readContract({ address: C.pool, abi: POOL, functionName: 'slot0' })),
    retry(() => pub.readContract({ address: C.pool, abi: POOL, functionName: 'token0' })),
    retry(() => pub.readContract({ address: C.pool, abi: POOL, functionName: 'observe', args: [[1800, 0]] }))
  ]);
  const d = obs[0][1] - obs[0][0];
  let avgTick = Number(d / 1800n); if (d < 0n && d % 1800n !== 0n) avgTick--;
  const usdtIs0 = t0.toLowerCase() === C.usdt.toLowerCase();
  const px = (tick) => { const raw = Math.pow(1.0001, tick); return usdtIs0 ? 1e12 / raw : raw * 1e12; };
  const spot = Number(s0[1]);
  return { avg: px(avgTick), spot: px(spot), gap: Math.abs(spot - avgTick), at: Date.now() };
}

/** Network totals across every vault, v1 and v2 (read from chain). */
async function readNetwork() {
  try {
    const [l1, l2] = await Promise.all([
      pub.readContract({ address: C.factory, abi: FACTORY1, functionName: 'vaultsPage', args: [0n, 300n] }).catch(() => []),
      HAS2 ? pub.readContract({ address: C.factory2, abi: FACTORY2, functionName: 'vaultsPage', args: [0n, 300n] }).catch(() => []) : []
    ]);
    const r1 = await Promise.all(l1.map((v) => Promise.all(['totalBought', 'volumeSwept', 'buys', 'lastBuyAt']
      .map((f) => pub.readContract({ address: v, abi: VAULT1, functionName: f }))).catch(() => [0n, 0n, 0n, 0n])));
    const r2 = await Promise.all(l2.map((v) => Promise.all(['direction', 'totalOut', 'volumeIn', 'trades', 'lastTradeAt']
      .map((f) => pub.readContract({ address: v, abi: VAULT2, functionName: f }))).catch(() => [0, 0n, 0n, 0n, 0n])));
    const n = { okb: 0n, usdtIn: 0n, profit: 0n, okbSold: 0n, trades: 0n, vaults: l1.length + l2.length, buyVaults: 0, sellVaults: 0 };
    r1.forEach(([o, i, b]) => { n.okb += o; n.usdtIn += i; n.trades += b; });
    r2.forEach(([d, out, inn, t]) => {
      if (Number(d) === 0) { n.okb += out; n.usdtIn += inn; n.buyVaults++; } else { n.profit += out; n.okbSold += inn; n.sellVaults++; }
      n.trades += t;
    });
    S.net = n;
    S.netVaults = [...l1.map((v, i) => ({ vault: v, version: 1, last: r1[i][3] })), ...l2.map((v, i) => ({ vault: v, version: 2, last: r2[i][4] }))];
  } catch { /* keep the last values */ }
}

async function readV1(v) {
  const r = (fn) => pub.readContract({ address: v, abi: VAULT1, functionName: fn });
  const [st, maxPrice, minInterval, lastBuyAt, spent, bought, buys] = await Promise.all([r('status'), r('maxPrice'), r('minInterval'), r('lastBuyAt'), r('volumeSwept'), r('totalBought'), r('buys')]);
  return { address: v, version: 1, paused: st[2], balance: st[3], perTxCap: st[4], dailyCap: st[5], keeper: st[7], savings: st[8], maxPrice, minInterval, lastBuyAt, spent, bought, buys };
}

async function readV2(v) {
  const F = ['keeper', 'savings', 'paused', 'direction', 'mode', 'tokenIn', 'tokenOut', 'baseAmount', 'perTxCap', 'dailyCap', 'refPrice', 'limitPrice',
    'minInterval', 'minAmount', 'lastTradeAt', 'nextTradeAt', 'spentTodayNow', 'volumeIn', 'totalOut', 'trades', 'feeBpsNow', 'twapPrice'];
  const vals = await Promise.all(F.map((f) => pub.readContract({ address: v, abi: VAULT2, functionName: f }).catch(() => null)));
  const d = { address: v, version: 2 };
  F.forEach((f, i) => { d[f] = vals[i]; });
  d.dir = Number(d.direction); d.mode = Number(d.mode);
  const [bal, stuck] = await Promise.all([d.tokenIn, d.tokenOut].map((t) => pub.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [v] }).catch(() => 0n)));
  d.balance = bal; d.stuck = stuck;
  try {
    const [inputs, k, amount, fee, minOut, avg] = await pub.readContract({ address: v, abi: VAULT2, functionName: 'preview', args: [d.keeper] });
    Object.assign(d, { inputs: Number(inputs), k: Number(k), amount, fee, minOut, avg });
    if (amount === 0n) {
      const [allow, kk] = await pub.readContract({ address: v, abi: VAULT2, functionName: 'chip', args: [(Number(inputs) & 0xff80) | SAFE] });
      d.strategyNo = !allow || Number(kk) === 0;
      d.kIfSafe = Number(kk);
    }
  } catch (e) { d.previewError = plain(e); }
  return d;
}

async function readMine() {
  if (!S.account) { S.v1 = []; S.v2 = []; return; }
  try {
    const owned = async (factory, fabi, vabi) => {
      const list = await pub.readContract({ address: factory, abi: fabi, functionName: 'vaultsOf', args: [S.account] });
      const owners = await Promise.all(list.map((v) => pub.readContract({ address: v, abi: vabi, functionName: 'owner' })));
      return list.filter((_, i) => owners[i].toLowerCase() === S.account.toLowerCase());
    };
    const [o1, o2] = await Promise.all([owned(C.factory, FACTORY1, VAULT1).catch(() => []), HAS2 ? owned(C.factory2, FACTORY2, VAULT2) : []]);
    [S.v1, S.v2] = await Promise.all([Promise.all(o1.map(readV1)), Promise.all(o2.map(readV2))]);
    S.wallet = await Promise.all([C.usdt, C.wokb].map((t) => pub.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [S.account] }).catch(() => null)))
      .then(([u, w]) => ({ usdt: u, wokb: w }));
    S.wallet.okb = await pub.getBalance({ address: S.account }).catch(() => null);
  } catch (e) { S.error = 'Could not read your vaults: ' + plain(e); }
}

/** Recent trades: yours (My vaults) and the whole network (Activity, Home). Loaded after the numbers. */
/** Full trade history, recorded by the Latch agent (the public RPC only lets a page search ~100 blocks
 *  at a time, so a page alone can find just each vault's latest trade). Every row has its tx hash,
 *  so anyone can check it on OKLink. Not used by the on-chain copy (no off-chain calls there). */
async function indexedTrades() {
  if (!C.keeperUrl) return null;
  try {
    const r = await fetch(C.keeperUrl + '/trades', { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.trades || []).map((t) => ({ vault: t.vault, version: t.version, hash: t.hash, block: BigInt(t.block), dir: t.dir,
      inn: BigInt(t.inn), out: BigInt(t.out), fee: BigInt(t.fee), price: BigInt(t.price), k: t.k }));
  } catch { return null; }
}
const mergeTrades = (...lists) => {
  const seen = new Set(), out = [];
  for (const t of lists.flat()) { const id = t.hash + ':' + t.vault.toLowerCase(); if (!seen.has(id)) { seen.add(id); out.push(t); } }
  return out.sort((a, b) => (b.block > a.block ? 1 : b.block < a.block ? -1 : 0));
};
async function loadTrades() {
  if (S.feedBusy) return;
  S.feedBusy = true;
  try {
    const [head, idx] = await Promise.all([pub.getBlock(), indexedTrades()]);
    const of = (v) => (idx || []).filter((t) => t.vault.toLowerCase() === v.toLowerCase());
    for (const d of [...S.v2, ...S.v1]) {
      const last = d.version === 2 ? d.lastTradeAt : d.lastBuyAt;
      try { S.hist[d.address] = mergeTrades(of(d.address), await tradesOf(d.address, d.version, last, head)).slice(0, 50); }
      catch { S.hist[d.address] = idx ? mergeTrades(of(d.address)).slice(0, 50) : S.hist[d.address] === undefined ? null : S.hist[d.address]; }
      render();
    }
    const recent = (S.netVaults || []).filter((x) => x.last > 0n).sort((a, b) => (b.last > a.last ? 1 : -1)).slice(0, 8);
    const feed = [];
    for (const x of recent) {
      try { feed.push(...(await tradesOf(x.vault, x.version, x.last, head, 0n)).slice(0, 3)); } catch { /* skip */ }
    }
    S.feed = mergeTrades(idx || [], feed).slice(0, 20);
    render();
  } catch { /* keep the last values */ }
  finally { S.feedBusy = false; }
}

/* Create draft survives the phone browser reloading the page while the wallet app is open. */
const DRAFT = 'latch.create.v2';
function saveDraft() {
  try { if (S.c) localStorage.setItem(DRAFT, JSON.stringify({ at: Date.now(), c: S.c })); else localStorage.removeItem(DRAFT); } catch {}
}
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT) || 'null');
    if (d && d.c && Date.now() - d.at < 86_400_000) return d.c;
    localStorage.removeItem(DRAFT);
  } catch {}
  return null;
}
/** If the page reloaded after "Create" was approved, find the new vault and move on to Add funds. */
async function recoverCreate() {
  const c = S.c;
  if (!c || c.step !== 3 || c.before == null || !S.account || !c.by || c.by.toLowerCase() !== S.account.toLowerCase()) return;
  try {
    const list = await pub.readContract({ address: C.factory2, abi: FACTORY2, functionName: 'vaultsOf', args: [S.account] });
    if (list.length > c.before) { c.created = list[list.length - 1]; c.step = 4; c.before = null; render(); }
  } catch {}
}

async function refresh() {
  if (S.refreshing) { S.again = true; render(); return; }
  S.refreshing = true; S.loading = true; render();
  try {
    await readMarket(); render();
    await Promise.all([readNetwork().then(render), readMine()]);
  } finally { S.refreshing = false; S.loading = false; render(); }
  if (S.again) { S.again = false; return refresh(); }
  recoverCreate();
  loadTrades();
}
hooks(() => render(), () => refresh());

/* ================================================================ shared bits */

const PAGES = [['home', 'Home'], ['try', 'Try it'], ['create', 'Create'], ['vaults', 'My vaults'], ['chip', 'The chip'], ['activity', 'Activity'], ['agents', 'Agents'], ['safety', 'Safety']];
const LOGO = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 3v4M12 3v4M16 3v4M8 17v4M12 17v4M16 17v4M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4" stroke="currentColor" stroke-width="1.6"/><rect x="8.5" y="8.5" width="7" height="7" rx="1" fill="currentColor"/></svg>`;
const ICON = {
  buy: `<svg viewBox="0 0 48 24" width="48" height="24" aria-hidden="true"><path d="M2 5 L14 8 L22 20 L30 13 L46 6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="22" cy="20" r="3" fill="currentColor"/></svg>`,
  sell: `<svg viewBox="0 0 48 24" width="48" height="24" aria-hidden="true"><path d="M2 19 L14 16 L22 5 L30 11 L46 18" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="22" cy="5" r="3" fill="currentColor"/></svg>`
};
const P = (n, d = 2) => (n == null || !Number.isFinite(n) ? '…' : n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const price6 = (v) => P(Number(v) / 1e6);
const amt = (v, dir) => (dir === 0 ? usd(v) + ' USDT0' : okb(v, 4) + ' OKB');
const outAmt = (v, dir) => (dir === 0 ? okb(v, 6) + ' OKB' : usd(v) + ' USDT0');
const kWord = (k) => (k === 0 ? 'no trade' : k + '×');

function header() {
  const conn = S.account
    ? `<span class="row gap"><button class="btn quiet sm acct" data-a="refresh" title="Refresh">${esc(short(S.account))}</button><button class="btn quiet sm" data-a="disconnect" title="Disconnect this wallet from Latch">Disconnect</button></span>`
    : `<button class="btn primary sm" data-a="connect">Connect wallet</button>`;
  const nav = PAGES.map(([id, label]) => `<a href="#/${id === 'home' ? '' : id}" class="${S.page === id ? 'on' : ''}" ${S.page === id ? 'aria-current="page"' : ''}>${label}</a>`).join('');
  return `<header class="hdr"><div class="wrap hdr-in">
    <a class="mark" href="#/" aria-label="Latch home">${LOGO}<span>Latch</span></a>
    <nav class="nav" aria-label="Pages">${nav}</nav>${conn}</div>
    <nav class="nav-m" aria-label="Pages">${nav}</nav></header>`;
}

function gateGrid(gates, small) {
  return `<div class="gates ${small ? 'sm' : ''}" role="img" aria-label="${GATE_COUNT} NAND gates, ${gates.filter(Boolean).length} switched on">${gates.map((g) => `<span class="${g ? 'hi' : ''}"></span>`).join('')}</div>`;
}

/** The interactive strategy chip (Home hero and The chip page). */
function chipWidget(full) {
  const x = S.x; const dir = x.dir;
  const input = pack({ safety: x.safety, depth: x.depth, vol: x.vol, mode: x.mode });
  const r = evalChip(input);
  const seg = (name, list, cur) => `<div class="seg" role="radiogroup" aria-label="${esc(name)}">${list.map((l, i) => `<button role="radio" aria-checked="${i === cur}" class="${i === cur ? 'on' : ''}" data-a="x" data-k="${name}" data-v="${i}">${esc(l)}</button>`).join('')}</div>`;
  const verdict = r.allow ? `${dir === 0 ? 'Buy' : 'Sell'} ${r.k}×` : 'Wait';
  const why = !r.allow && (x.safety !== SAFE) ? 'A safety check failed, so nothing trades, whatever the strategy says.'
    : !r.allow ? (x.vol === 3 && x.mode >= 2 ? 'The market is very jumpy: smart and ladder strategies pause.' : `${MODES[dir][x.mode].name} waits: OKB is ${depthWord(x.depth, dir)}.`)
    : r.k === 1 && x.vol >= 2 && x.mode >= 2 ? 'Jumpy market: the chip drops to the base amount.' : `${r.k} × your base amount, sent straight to your wallet.`;
  return `<figure class="chipw ${r.allow ? 'allow' : 'deny'} ${full ? 'full' : ''}" aria-label="Strategy chip, interactive">
    <div class="chipw-in">
      <div class="ctl">
        <div class="ctl-row"><span class="ctl-l">Vault</span>${seg('dir', ['Buy OKB', 'Take profit'], dir)}</div>
        <div class="ctl-row"><span class="ctl-l">Strategy</span>${seg('mode', MODES[dir].map((m) => m.name), x.mode)}</div>
        <label class="ctl-row"><span class="ctl-l">OKB ${dir === 0 ? 'below' : 'above'} reference</span>
          <input type="range" min="0" max="7" step="1" value="${x.depth}" data-a="xr" data-k="depth" aria-valuetext="${esc(DEPTHS[x.depth])}">
          <span class="ctl-v num">${esc(x.depth === 0 ? 'no move' : DEPTHS[x.depth])}</span></label>
        <div class="ctl-row"><span class="ctl-l">Market</span>${seg('vol', VOLS, x.vol)}</div>
        ${full ? `<div class="ctl-row"><span class="ctl-l">Safety checks</span><div class="safety">${SAFETY.map(([l, bit, inv]) => {
          const on = (x.safety >> bit) & 1; const good = inv ? !on : !!on;
          return `<button class="pin ${good ? 'ok' : 'bad'}" data-a="xs" data-bit="${bit}" aria-pressed="${!!on}">${esc(inv ? (on ? 'Paused by the owner' : 'Not paused') : l)}</button>`;
        }).join('')}</div></div>` : ''}
      </div>
      <div class="die">
        ${gateGrid(r.gates, !full)}
        <p class="die-name">TapeOut circuit #${CID2} · ${GATE_COUNT} NAND gates</p>
        <p class="die-sub hex">input 0x${input.toString(16).padStart(4, '0')} → output 0b${(r.k << 1 | (r.allow ? 1 : 0)).toString(2).padStart(3, '0')}</p>
      </div>
      <div class="verdict" aria-live="polite">
        <p class="verdict-word">${verdict}</p>
        <p class="verdict-sub">${esc(why)}</p>
        <button class="btn quiet sm" data-a="askChip">${x.live === 'asking' ? 'Asking the chain…' : x.live ? `Chain says: ${esc(x.live)}` : 'Ask the real chip'}</button>
      </div>
    </div>
    <figcaption>This is the real circuit that is live on X Layer, running in your browser. Change the inputs; "Ask the real chip" sends the same input to the TapeOut processor on chain.</figcaption>
  </figure>`;
}

function errBox() { return S.error && !S.dialog ? `<p class="err" role="alert">${esc(S.error)}</p>` : ''; }

/* ================================================================ pages */

function pageHome() {
  const n = S.net;
  const feed = (S.feed || []).slice(0, 4);
  return `<section class="hero wrap">
    <div class="hero-copy">
      <h1>Buy OKB on dips. Take profit on rises. A chip decides how much.</h1>
      <p class="lead">Put USDT0 or OKB in a vault only you control. Latch trades for you on Uniswap, and the size of every trade is decided on chain by a 101-gate TapeOut circuit: more when the move is bigger, less when the market is jumpy, nothing when your rules say no. The bot can never withdraw, raise your limits or send money anywhere but your wallet.</p>
      <div class="cta-row"><a class="btn primary lg" href="#/create?buy">Buy OKB automatically</a><a class="btn quiet lg" href="#/create?sell">Take profit automatically</a></div>
      <p class="fine">No wallet yet? <a href="#/try">Try it: see what a vault would do right now</a>.</p>
      <dl class="facts">
        <div><dt>OKB price</dt><dd class="num">${P(S.price)}</dd></div>
        <div><dt>Trades checked by chip</dt><dd class="num">${n ? n.trades : '…'}</dd></div>
        <div><dt>OKB bought</dt><dd class="num">${n ? okb(n.okb, 4) : '…'}</dd></div>
        <div><dt>Vaults</dt><dd class="num">${n ? n.vaults : '…'}</dd></div>
      </dl>
    </div>
    ${chipWidget(false)}
  </section>
  <section class="wrap block"><h2>Two jobs, one vault each</h2>
    <div class="jobs">
      <a class="job" href="#/create?buy"><span class="job-icon">${ICON.buy}</span><b>Buy OKB</b><span>Holds USDT0. Buys a little every day, or only on dips, or more the deeper it falls. OKB goes straight to your wallet.</span></a>
      <a class="job" href="#/create?sell"><span class="job-icon">${ICON.sell}</span><b>Take profit</b><span>Holds OKB. Sells a little as the price rises above your reference, more on bigger rises, never under your floor. USDT0 goes straight to your wallet.</span></a>
    </div></section>
  <section class="wrap block"><h2>How a trade happens</h2>
    <ol class="flow">
      <li><b>The agent asks</b><span>Every minute, Latch's agent asks each vault for a trade. It follows your rules; it cannot change them.</span></li>
      <li><b>Your vault measures</b><span>How far OKB moved from your reference, how jumpy the market is, and 7 safety facts.</span></li>
      <li><b>The chip decides</b><span>Circuit #${CID2} answers: no trade, 1×, 2× or 3× your base amount.</span></li>
      <li><b>Uniswap swaps</b><span>At the fair price, or the swap is refused.</span></li>
      <li><b>Your wallet receives</b><span>OKB (as WOKB) or USDT0. Never anywhere else.</span></li>
    </ol>
    <p class="fine">Prefer to ask an AI assistant? With the OKX Agentic Wallet, your AI agent can create and manage vaults for you. <a href="#/agents">How agents use Latch</a></p></section>
  ${feed.length ? `<section class="wrap block"><div class="row between"><h2>Latest trades</h2><a href="#/activity">All activity</a></div>${feedList(feed)}</section>` : ''}`;
}

/* ---------- Create ---------- */
function newCreate(dir) {
  const p = S.price || 80;
  const c = { step: dir == null ? 0 : 1, dir: dir ?? 0, mode: 2, spacing: '86400', savings: S.account || '', ownBot: false, botAddr: '', limitsTouched: false };
  setDefaults(c, p);
  return c;
}
function setDefaults(c, p = S.price || 80) {
  if (c.dir === 0) { c.base = '2'; c.ref = (Math.round(p * 10) / 10).toString(); c.limit = Math.ceil(p * 1.2).toString(); c.deposit = '20'; }
  else { c.base = '0.02'; c.ref = (Math.round(p * 10) / 10).toString(); c.limit = (Math.floor(p * 10) / 10).toString(); c.deposit = '0.1'; }
  suggestLimits(c);
}
const maxK = (mode) => Math.max(...curve(mode, 0));
function suggestLimits(c) {
  if (c.limitsTouched) return;
  const b = Number(c.base) || 0; const m = maxK(c.mode);
  c.perTx = trim(b * m); c.daily = trim(b * m);
}
const trim = (n) => String(Number(n.toFixed(6)));

/** Plain-English sentence for a strategy (create review + vault cards). */
function describe(dir, mode, baseStr, refP, limitP, spacing) {
  const unit = dir === 0 ? 'USDT0 of OKB' : 'OKB';
  const u = dir === 0 ? 'USDT0' : 'OKB';
  const b = Number(baseStr);
  const cv = curve(mode, 0);
  const verb = dir === 0 ? 'buys' : 'sells';
  const rel = dir === 0 ? 'below' : 'above';
  const at = (d) => (d === 1 ? `${rel} ${P(refP)}` : `${[0, 0, 5, 10, 15, 20, 30, 40][d]}% or more ${rel} ${P(refP)}`);
  const often = spacingText(BigInt(spacing));
  const guard = dir === 0 ? `never paying more than ${P(limitP)}` : `never selling under ${P(limitP)}`;
  const steps = []; let prev = 0;
  cv.forEach((k, d) => { if (k !== prev) { steps.push([k, d]); prev = k; } });
  if (mode === 0) return `Latch ${verb} ${trim(b)} ${unit} ${often}, whatever the move, ${guard}.`;
  const jumpy = mode >= 2 ? ' In a jumpy market it trades only the base amount; in a very jumpy one it waits.' : '';
  if (cv[0] > 0) {
    const more = steps.filter(([, d]) => d > 0).map(([k, d]) => `${trim(b * k)} ${u} when OKB is ${at(d)}`).join(', ');
    return `Latch ${verb} ${trim(b * cv[0])} ${unit} ${often}${more ? `, rising to ${more}` : ''}, ${guard}.${jumpy}`;
  }
  const parts = steps.map(([k, d]) => `${trim(b * k)} ${u} when OKB is ${at(d)}`).join(', ');
  return `Latch ${verb} ${often}, only on a move: ${parts}, ${guard}.${jumpy}`;
}

function curveRow(dir, mode, vol = 0) {
  const cv = curve(mode, vol);
  return `<div class="curve" role="img" aria-label="Trade size by move">${cv.map((k, d) => `<span class="k${k}" title="${esc(DEPTHS[d])}: ${kWord(k)}"><i style="height:${k * 24}%"></i><em>${k ? k + '×' : '–'}</em></span>`).join('')}</div>
    <div class="curve-x"><span>${dir === 0 ? 'no dip' : 'no rise'}</span><span>−/+5%</span><span>15%</span><span>30%+</span></div>`;
}

function pageCreate() {
  if (!HAS2) return `<section class="wrap block"><h1 class="pg">Create a vault</h1><p>Version 2 is not configured on this site yet.</p></section>`;
  if (!S.c) S.c = newCreate(null);
  const c = S.c; const dir = c.dir;
  const steps = ['Goal', 'Strategy', 'Amounts', 'Review', 'Add funds'];
  const bar = `<ol class="steps">${steps.map((s, i) => `<li class="${i === c.step ? 'on' : i < c.step ? 'done' : ''}">${s}</li>`).join('')}</ol>`;
  const nav = (back, next, label = 'Continue', dis = '') => `<div class="row between">${back ? `<button class="btn quiet" data-a="cback">Back</button>` : '<span></span>'}${next ? `<button class="btn primary" data-a="${next}" ${dis}>${label}</button>` : ''}</div>`;
  let body = '';
  if (c.step === 0) {
    body = `<div class="jobs">
      <button class="job ${dir === 0 ? 'sel' : ''}" data-a="cdir" data-v="0"><span class="job-icon">${ICON.buy}</span><b>Buy OKB</b><span>Your vault holds USDT0 and buys OKB for you.</span></button>
      <button class="job ${dir === 1 ? 'sel' : ''}" data-a="cdir" data-v="1"><span class="job-icon">${ICON.sell}</span><b>Take profit</b><span>Your vault holds OKB and sells some for USDT0 as the price rises.</span></button>
    </div>${nav(false, 'cnext')}`;
  } else if (c.step === 1) {
    body = `<div class="modes">${MODES[dir].map((m, i) => `<button class="mode ${c.mode === i ? 'sel' : ''}" data-a="cmode" data-v="${i}">
        <b>${esc(m.name)}</b><span>${esc(m.line)}</span>${curveRow(dir, i)}</button>`).join('')}</div>
      <p class="fine">Bars: trade size the chip picks as OKB moves ${dir === 0 ? 'below' : 'above'} your reference price (calm market).</p>
      ${nav(true, 'cnext')}`;
  } else if (c.step === 2) {
    const u = dir === 0 ? 'USDT0' : 'OKB';
    const min = dir === 0 ? usd(S.mins.buy) : okb(S.mins.sell, 4);
    body = `<div class="form two">
      <label>Base amount per trade (${u})<input id="c-base" data-c="base" type="number" min="0" step="any" inputmode="decimal" value="${esc(c.base)}"><small>1× trade. At least ${min} ${u}.</small></label>
      <label>How often, at most<select id="c-spacing" data-c="spacing">${[['3600', 'Every hour'], ['86400', 'Every day'], ['604800', 'Every week'], ['0', 'Whenever the chip allows']].map(([v, l]) => `<option value="${v}" ${c.spacing === v ? 'selected' : ''}>${l}</option>`).join('')}</select><small>The agent checks every minute.</small></label>
      <label>Reference price (USDT0 per OKB)<input id="c-ref" data-c="ref" type="number" step="any" inputmode="decimal" value="${esc(c.ref)}"><small>Moves are measured from here. OKB is ${P(S.price)} now.</small></label>
      <label>${dir === 0 ? 'Never pay more than' : 'Never sell under'} (USDT0 per OKB)<input id="c-limit" data-c="limit" type="number" step="any" inputmode="decimal" value="${esc(c.limit)}"><small>${dir === 0 ? 'A ceiling: no buys during a spike.' : 'A floor: no sales in a crash.'}</small></label>
      <label>Most per trade (${u})<input id="c-perTx" data-c="perTx" type="number" step="any" inputmode="decimal" value="${esc(c.perTx)}"><small>Can be lowered later, never raised.</small></label>
      <label>Most per day (${u})<input id="c-daily" data-c="daily" type="number" step="any" inputmode="decimal" value="${esc(c.daily)}"><small>Can be lowered later, never raised.</small></label>
      <label class="span2">Send the ${dir === 0 ? 'OKB' : 'USDT0'} to<input id="c-savings" data-c="savings" type="text" spellcheck="false" value="${esc(c.savings)}"><small>Fixed forever once the vault is created.</small></label>
      <details class="span2" ${c.ownBot ? 'open' : ''}><summary>Use my own agent (AI or script)</summary>
        <label class="chk"><input id="c-ownBot" data-c="ownBot" type="checkbox" ${c.ownBot ? 'checked' : ''}> Use my own agent instead of Latch's</label>
        <label>Agent address<input id="c-botAddr" data-c="botAddr" type="text" spellcheck="false" placeholder="0x…" value="${esc(c.botAddr)}"><small>Same limits; it can never withdraw or change settings.</small></label>
      </details>
    </div>${nav(true, 'cnext', 'Review')}`;
  } else if (c.step === 3) {
    body = `<p class="summary">${esc(describe(dir, c.mode, c.base, Number(c.ref), Number(c.limit), c.spacing))}</p>
      ${curveRow(dir, c.mode)}
      <ul class="terms">
        <li>At most ${esc(c.perTx)} ${dir === 0 ? 'USDT0' : 'OKB'} per trade and ${esc(c.daily)} per day.</li>
        <li>${dir === 0 ? 'OKB (as WOKB, worth 1 OKB each)' : 'USDT0'} goes to <span class="num">${esc(short(c.savings))}</span>.</li>
        <li>Prices use Uniswap's 30-minute average. A trade is refused if the price is more than about 1% away from it, or if the fill would break your ${dir === 0 ? 'ceiling' : 'floor'}.</li>
        <li>${c.ownBot ? 'Your agent' : 'Latch’s agent'} can only trigger trades. It can't withdraw, raise limits or redirect funds.</li>
        <li>TapeOut circuit #${CID2} decides the size of every trade on chain.</li>
        <li>Fee: 1% of each trade, falling with volume. Pause or withdraw any time.</li>
      </ul>${nav(true, 'ccreate', S.busy ? esc(S.busy) + '…' : 'Create my vault', S.busy ? 'disabled' : '')}`;
  } else {
    const w = S.wallet || {};
    const fundTok = dir === 0 ? 'USDT0' : 'WOKB';
    const have = dir === 0 ? w.usdt : w.wokb;
    body = `<p class="summary">Your vault is live: ${link(c.created)}. Add ${fundTok} for it to ${dir === 0 ? 'spend' : 'sell'}.</p>
      <div class="form"><label>Amount to add (${fundTok})<input id="c-deposit" data-c="deposit" type="number" min="0" step="any" inputmode="decimal" value="${esc(c.deposit)}">
        <small>Your wallet holds ${have != null ? (dir === 0 ? usd(have) : okb(have, 4)) : '…'} ${fundTok}${dir === 1 && w.okb != null ? ` and ${okb(w.okb, 4)} OKB` : ''}.</small></label></div>
      ${dir === 1 ? `<p class="fine">Uniswap trades WOKB (wrapped OKB, always worth 1 OKB). If you hold plain OKB, wrap some first: it is one transaction and you can unwrap any time.</p>` : ''}
      ${fundSteps({ version: 2, dir, address: c.created })}
      <div class="row between"><a class="btn quiet" href="#/vaults">Later</a><span class="row gap">${dir === 1 ? `<button class="btn quiet" data-a="cwrap" ${S.busy ? 'disabled' : ''}>Wrap OKB → WOKB</button>` : ''}<button class="btn primary" data-a="cdeposit" ${S.busy ? 'disabled' : ''}>${S.busy ? esc(S.busy) + '…' : 'Add ' + fundTok}</button></span></div>`;
  }
  return `<section class="wrap block narrow"><h1 class="pg">${c.step === 0 ? 'Create a vault' : dir === 0 ? 'Buy OKB automatically' : 'Take profit automatically'}</h1>
    ${bar}${errBox()}${body}</section>`;
}

/* ---------- My vaults ---------- */
function reasonV2(d) {
  if (d.paused) return 'Paused. Nothing trades until you resume.';
  if (d.previewError) return 'Checks unavailable right now: ' + d.previewError;
  if (d.amount > 0n) return `The chip says ${d.dir === 0 ? 'buy' : 'sell'} ${d.k}× (${amt(d.amount, d.dir)}). Latch's agent trades within about a minute.`;
  if (d.dailyCap - d.spentTodayNow < d.minAmount) return 'Today’s limit is used. Next trade after midnight UTC.';
  if (d.nextTradeAt > 0n) return `Next trade possible in ${when(d.nextTradeAt)}.`;
  if (d.balance < d.minAmount) return `Add ${d.dir === 0 ? 'USDT0' : 'WOKB'} so Latch has something to ${d.dir === 0 ? 'buy with' : 'sell'}.`;
  if (d.strategyNo) {
    const dep = (d.inputs >> 7) & 7, vol = (d.inputs >> 10) & 3;
    return vol === 3 && d.mode >= 2 ? 'The market is very jumpy; the strategy waits for it to calm down.'
      : `Waiting: OKB is ${depthWord(dep, d.dir)} (${price6(d.refPrice)}).`;
  }
  if (!((d.inputs >> 3) & 1)) return d.dir === 0 ? `Waiting: OKB is above your ceiling of ${price6(d.limitPrice)}, or moving too fast.` : `Waiting: OKB is under your floor of ${price6(d.limitPrice)}, or moving too fast.`;
  return 'Waiting for the next check.';
}
/** One plain word for the safety side. When the strategy sizes a trade at 0, size-dependent checks fail too,
 *  so name the real cause rather than counting failed bits. */
function safetyWord(d) {
  if (d.inputs == null) return '…';
  if ((d.inputs & 0x7f) === SAFE) return 'all 7 pass';
  if (d.paused) return 'paused by you';
  if (d.dailyCap - d.spentTodayNow < d.minAmount) return 'daily limit used';
  if (d.nextTradeAt > 0n) return 'spacing: wait';
  if (d.balance < d.minAmount) return 'needs funds';
  if (d.strategyNo) return 'pass (strategy waits)';
  if (!((d.inputs >> 3) & 1)) return d.dir === 0 ? 'above your ceiling' : 'under your floor';
  return 'not met';
}
function vaultCard2(d) {
  const dir = d.dir; const m = MODES[dir][d.mode];
  const status = d.paused ? ['Paused', 'paused'] : d.amount > 0n ? [dir === 0 ? 'Buying' : 'Selling', 'live'] : ['Waiting', 'wait'];
  const avg = d.dir === 0 ? (d.totalOut > 0n ? (Number(d.volumeIn) / 1e6) / (Number(d.totalOut) / 1e18) : null) : (d.volumeIn > 0n ? (Number(d.totalOut) / 1e6) / (Number(d.volumeIn) / 1e18) : null);
  const usedPct = d.dailyCap > 0n ? Math.min(100, Number((d.spentTodayNow * 100n) / d.dailyCap)) : 0;
  const dep = d.inputs != null ? (d.inputs >> 7) & 7 : 0, vol = d.inputs != null ? (d.inputs >> 10) & 3 : 0;
  const h = S.hist[d.address];
  const hist = h === undefined ? '<p class="muted">Loading recent trades…</p>' : h === null ? '<p class="muted">Recent trades could not be loaded.</p>'
    : h.length ? histTable(h) : '<p class="muted">No trades yet.</p>';
  const unitIn = dir === 0 ? 'USDT0' : 'WOKB';
  const busy = S.busy ? 'disabled' : '';
  return `<article class="vault" data-v="${d.address}" data-ver="2">
    <header class="vault-head"><span class="vault-icon">${dir === 0 ? ICON.buy : ICON.sell}</span>
      <div><h3>${dir === 0 ? 'Buy OKB' : 'Take profit'} · ${esc(m.name)}</h3><p class="muted">${esc(describe(dir, d.mode, formatUnits(d.baseAmount, dir === 0 ? 6 : 18), Number(d.refPrice) / 1e6, Number(d.limitPrice) / 1e6, String(d.minInterval)))}</p></div>
      <span class="status ${status[1]}">${status[0]}</span></header>
    <dl class="vault-stats">
      <div><dt>${dir === 0 ? 'OKB bought' : 'USDT0 taken'}</dt><dd class="num">${dir === 0 ? okb(d.totalOut, 6) : usd(d.totalOut)}</dd></div>
      <div><dt>Average price</dt><dd class="num">${avg ? P(avg) : '—'}</dd></div>
      <div><dt>${unitIn} left</dt><dd class="num">${dir === 0 ? usd(d.balance) : okb(d.balance, 4)}</dd></div>
      <div><dt>Trades</dt><dd class="num">${d.trades}</dd></div>
    </dl>
    <div class="sees">
      <p class="sees-t">What the chip sees now</p>
      <ul class="sees-l">
        <li><span>Move</span><b>${esc(d.inputs != null ? depthWord(dep, dir) : '…')}</b></li>
        <li><span>Market</span><b>${esc(d.inputs != null ? VOLS[vol] : '…')}</b></li>
        <li><span>Safety</span><b class="${d.inputs != null && (d.inputs & 0x7f) === SAFE ? 'ok' : ''}">${esc(safetyWord(d))}</b></li>
        <li><span>Decision</span><b class="${d.amount > 0n ? 'ok' : ''}">${d.amount > 0n ? `${dir === 0 ? 'buy' : 'sell'} ${d.k}×` : 'wait'}</b></li>
      </ul>
    </div>
    <div class="meter" role="img" aria-label="${usedPct}% of today's limit used"><span style="width:${usedPct}%"></span></div>
    <p class="meter-label"><span>${amt(d.spentTodayNow, dir)} of ${amt(d.dailyCap, dir)} used today</span><span>${esc(reasonV2(d))}</span></p>
    <details data-k="${d.address}:rules" ${S.open[d.address + ':rules'] ? 'open' : ''}><summary>Settings and safety checks</summary>
      <ul class="kv">
        <li><span>Base amount (1×)</span><b class="num">${amt(d.baseAmount, dir)}</b></li>
        <li><span>Most per trade / per day</span><b class="num">${amt(d.perTxCap, dir)} / ${amt(d.dailyCap, dir)}</b></li>
        <li><span>Reference price</span><b class="num">${price6(d.refPrice)}</b></li>
        <li><span>${dir === 0 ? 'Ceiling' : 'Floor'}</span><b class="num">${price6(d.limitPrice)}</b></li>
        <li><span>30-min average now</span><b class="num">${d.twapPrice ? price6(d.twapPrice) : '…'}</b></li>
        <li><span>Spacing</span><b>${esc(spacingText(d.minInterval))}</b></li>
      </ul>
      ${d.inputs != null ? `<ul class="checks">${SAFETY.map(([l, b, inv]) => { const on = (d.inputs >> b) & 1; const pass = inv ? !on : !!on; return `<li class="${pass ? 'ok' : 'bad'}">${esc(inv ? 'Not paused by you' : l)}</li>`; }).join('')}</ul>
      <p class="chip-line">Chip input <span class="num">0x${d.inputs.toString(16).padStart(4, '0')}</span> · ${link(C.processor, 'address', 'circuit #' + CID2 + ' on chain')}</p>` : ''}
    </details>
    <details data-k="${d.address}:hist" ${S.open[d.address + ':hist'] ? 'open' : ''}><summary>Recent trades</summary>${hist}</details>
    ${d.balance === 0n ? `<p class="empty-note">This vault is empty. Add ${unitIn} to start ${dir === 0 ? 'buying' : 'taking profit'}.</p>` : ''}
    <div class="actions">
      <button class="btn primary sm" data-a="vadd" ${busy}>Add ${unitIn}</button>
      <button class="btn quiet sm" data-a="${d.paused ? 'vresume' : 'vpause'}" ${busy}>${d.paused ? 'Resume' : 'Pause'}</button>
      <button class="btn quiet sm" data-a="vstrategy" ${busy}>Change strategy</button>
      <button class="btn quiet sm" data-a="vwithdraw" ${busy}>Withdraw all</button>
    </div>
    <p class="fine">Vault <span class="hex">${esc(short(d.address))}</span> <button type="button" class="linkbtn" data-a="copyAddr" data-addr="${d.address}">${S.copiedAddr === d.address ? 'Copied' : 'Copy address'}</button> (${link(d.address, 'address', 'OKLink')}) · output to ${link(d.savings)} · agent ${d.keeper && S.hostedKeeper && d.keeper.toLowerCase() === S.hostedKeeper.toLowerCase() ? 'Latch hosted' : link(d.keeper)} · fee ${(Number(d.feeBpsNow) / 100).toFixed(2)}%</p>
  </article>`;
}
function vaultCard1(d) {
  const busy = S.busy ? 'disabled' : '';
  const avg = d.bought > 0n ? (Number(d.spent) / 1e6) / (Number(d.bought) / 1e18) : null;
  return `<article class="vault classic" data-v="${d.address}" data-ver="1">
    <header class="vault-head"><span class="vault-icon">${ICON.buy}</span>
      <div><h3>Classic buy vault</h3><p class="muted">${usd(d.perTxCap)} USDT0 per buy, ${esc(spacingText(d.minInterval))}, at ${usd(d.maxPrice)} or lower. Checked by safety circuit #${C.circuitId}.</p></div>
      <span class="status ${d.paused ? 'paused' : 'live'}">${d.paused ? 'Paused' : 'On'}</span></header>
    <dl class="vault-stats">
      <div><dt>OKB bought</dt><dd class="num">${okb(d.bought)}</dd></div>
      <div><dt>Average price</dt><dd class="num">${avg ? P(avg) : '—'}</dd></div>
      <div><dt>USDT0 left</dt><dd class="num">${usd(d.balance)}</dd></div>
      <div><dt>Buys</dt><dd class="num">${d.buys}</dd></div>
    </dl>
    ${d.balance === 0n ? '<p class="empty-note">This vault is empty. Add USDT0 to start buying.</p>' : ''}
    <div class="actions">
      <button class="btn primary sm" data-a="vadd" ${busy}>Add USDT0</button>
      <button class="btn quiet sm" data-a="${d.paused ? 'vresume' : 'vpause'}" ${busy}>${d.paused ? 'Resume' : 'Pause'}</button>
      <button class="btn quiet sm" data-a="vwithdraw" ${busy}>Withdraw all</button>
    </div>
    <p class="fine">Vault <span class="hex">${esc(short(d.address))}</span> <button type="button" class="linkbtn" data-a="copyAddr" data-addr="${d.address}">${S.copiedAddr === d.address ? 'Copied' : 'Copy address'}</button> (${link(d.address, 'address', 'OKLink')}) · OKB to ${link(d.savings)}</p>
  </article>`;
}
function pageVaults() {
  if (!S.account) return `<section class="wrap block narrow"><h1 class="pg">My vaults</h1><div class="empty"><p>Connect the wallet that owns your vaults.</p><button class="btn primary" data-a="connect">Connect wallet</button></div></section>`;
  const none = !S.v1.length && !S.v2.length;
  return `<section class="wrap block"><div class="row between"><h1 class="pg">My vaults</h1><span class="row gap"><a class="btn primary sm" href="#/create">New vault</a><button class="btn quiet sm" data-a="refresh">${S.loading ? 'Loading…' : 'Refresh'}</button></span></div>
    ${errBox()}
    ${none ? (S.loading ? '<p class="muted">Loading…</p>' : `<div class="empty"><p>No vault yet. It takes one transaction to create one.</p><a class="btn primary" href="#/create">Create a vault</a></div>`) : ''}
    ${S.v2.map(vaultCard2).join('')}
    ${S.v1.length ? `<h2 class="sub">Classic vaults</h2>${S.v1.map(vaultCard1).join('')}` : ''}
    ${S.txs.length ? `<p class="fine">Last action: ${esc(S.txs[0].label)}, ${esc(S.txs[0].state)}. ${link(S.txs[0].hash, 'tx')}</p>` : ''}</section>`;
}

/* ---------- The chip ---------- */
function pageChip() {
  const x = S.x;
  const table = (dir) => `<table class="grid"><thead><tr><th>Strategy</th>${DEPTHS.map((d, i) => `<th>${i === 0 ? (dir === 0 ? 'no dip' : 'no rise') : esc(d)}</th>`).join('')}</tr></thead>
    <tbody>${MODES[dir].map((m, i) => `<tr><th>${esc(m.name)}</th>${curve(i, x.vol).map((k) => `<td class="k${k}">${k ? k + '×' : '–'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  return `<section class="wrap block"><h1 class="pg">The strategy chip</h1>
    <p class="lead-s">Every trade's size is decided by TapeOut circuit #${CID2}: ${GATE_COUNT} NAND gates taped out on X Layer at processor ${link(C.processor)}. The vault turns the market into 16 input bits; the chip answers with 3 bits: allow, and a size of 1×, 2× or 3×. Nothing in the bot or the website can change that answer.</p>
    ${chipWidget(true)}</section>
  <section class="wrap block"><h2>Everything the chip can answer (market: ${esc(VOLS[x.vol])})</h2>
    <p class="fine">Change "Market" above to see how each strategy reacts to a jumpy market. All safety checks passing.</p>
    <h3 class="sub">Buy OKB: how far below the reference</h3><div class="scroll">${table(0)}</div>
    <h3 class="sub">Take profit: how far above the reference</h3><div class="scroll">${table(1)}</div></section>
  <section class="wrap block split">
    <div><h2>What goes in</h2><ul class="plain">
      <li>7 safety facts, all must hold: not paused, the vault's own agent, output to the owner's wallet, price inside the owner's limit and stable, size within limits, daily limit and spacing, enough funds.</li>
      <li>How far OKB's 30-minute average moved from the owner's reference price, in 8 steps.</li>
      <li>How jumpy the market is: the gap between the live price and the 30-minute average, in 4 steps.</li>
      <li>The owner's strategy: steady, dips/rises only, smart or ladder.</li></ul></div>
    <div><h2>Checked, not trusted</h2><p>The netlist was checked against the written rules for all 65,536 possible inputs before tape-out, then again against the live processor. The vault still enforces every money rule in Solidity too, so even a wrong answer from a chip could not exceed your limits or send funds anywhere else.</p>
      <p>Classic vaults use safety circuit #${C.circuitId} (13 NAND gates), which checks the same 7 safety facts.</p>
      <p><a href="${C.repo}/tree/main/circuits" target="_blank" rel="noopener">Read the circuit source and its checks</a></p></div>
  </section>`;
}

/* ---------- Try it (no wallet) ---------- */
/** What a vault with these settings would do at this moment, from the live pool and the real chip. */
function tryDecision(t) {
  const m = t.mkt; if (!m) return null;
  const ref = Number(t.ref), limit = Number(t.limit), base = Number(t.base);
  const depth = depthOf(m.avg, ref, t.dir);
  const vol = m.gap < 15 ? 0 : m.gap < 35 ? 1 : m.gap < 60 ? 2 : 3;
  const priceOk = (t.dir === 0 ? m.avg <= limit : m.avg >= limit) && m.gap <= 100;
  const input = pack({ safety: priceOk ? SAFE : SAFE & ~8, depth, vol, mode: t.mode });
  return { depth, vol, priceOk, input, ...evalChip(input), base };
}
function pageTry() {
  const t = S.t; const dir = t.dir; const u = dir === 0 ? 'USDT0' : 'OKB';
  if (!t.ref && S.price) { t.ref = (Math.round(S.price * (dir === 0 ? 1.12 : 0.9) * 10) / 10).toString(); t.limit = (dir === 0 ? Math.ceil(S.price * 1.2) : Math.floor(S.price * 0.85)).toString(); }
  const r = tryDecision(t); const m = t.mkt;
  const seg = (k, list, cur) => `<div class="seg" role="radiogroup">${list.map((l, i) => `<button role="radio" aria-checked="${i === cur}" class="${i === cur ? 'on' : ''}" data-a="t" data-k="${k}" data-v="${i}">${esc(l)}</button>`).join('')}</div>`;
  let verdict = 'Reading the market…', sub = '';
  if (m && r) {
    const amtStr = r.allow ? `${trim(r.base * r.k)} ${u}` : '';
    verdict = r.allow ? `${dir === 0 ? 'Buy' : 'Sell'} ${r.k}× · ${amtStr}` : 'Wait';
    sub = !r.priceOk ? (dir === 0 ? `OKB's 30-minute average (${P(m.avg)}) is above your ceiling of ${P(Number(t.limit))}.` : `OKB's 30-minute average (${P(m.avg)}) is under your floor of ${P(Number(t.limit))}.`)
      : !r.allow ? (r.vol === 3 && t.mode >= 2 ? 'The market is very jumpy right now, so this strategy waits.' : `OKB is ${depthWord(r.depth, dir)} (${P(Number(t.ref))}), so this strategy waits.`)
      : `OKB is ${depthWord(r.depth, dir)} (${P(Number(t.ref))}) and the market is ${VOLS[r.vol]}, so circuit #${CID2} picks ${r.k}× your base amount.`;
  }
  return `<section class="wrap block"><h1 class="pg">Try it: what would my vault do right now?</h1>
    <p class="lead-s">No wallet needed. Pick a job and a strategy, and see what a Latch vault would do at this moment, using the live Uniswap price and the real chip on X Layer.</p>
    <div class="split try">
      <div class="form">
        <div class="ctl-row"><span class="ctl-l">Job</span>${seg('dir', ['Buy OKB', 'Take profit'], dir)}</div>
        <div class="ctl-row"><span class="ctl-l">Strategy</span>${seg('mode', MODES[dir].map((x) => x.name), t.mode)}</div>
        <p class="fine">${esc(MODES[dir][t.mode].line)}</p>
        <label>Base amount per trade (${u})<input id="t-base" data-t="base" type="number" step="any" inputmode="decimal" value="${esc(t.base)}"></label>
        <label>Reference price<input id="t-ref" data-t="ref" type="number" step="any" inputmode="decimal" value="${esc(t.ref)}"><small>Moves are measured from here.</small></label>
        <label>${dir === 0 ? 'Never pay more than' : 'Never sell under'}<input id="t-limit" data-t="limit" type="number" step="any" inputmode="decimal" value="${esc(t.limit)}"></label>
      </div>
      <div class="chipw ${r?.allow ? 'allow' : 'deny'}">
        <dl class="facts">
          <div><dt>30-minute average</dt><dd class="num">${m ? P(m.avg) : '…'}</dd></div>
          <div><dt>Live price</dt><dd class="num">${m ? P(m.spot) : '…'}</dd></div>
          <div><dt>Move vs reference</dt><dd>${r ? esc(r.depth === 0 ? 'none' : DEPTHS[r.depth]) : '…'}</dd></div>
          <div><dt>Market</dt><dd>${r ? esc(VOLS[r.vol]) : '…'}</dd></div>
        </dl>
        ${r ? gateGrid(r.gates, true) : ''}
        <div class="verdict" aria-live="polite"><p class="verdict-word">${esc(verdict)}</p><p class="verdict-sub">${esc(sub)}</p>
          ${r ? `<p class="die-sub hex">chip input 0x${r.input.toString(16).padStart(4, '0')}</p>` : ''}
          <div class="row gap" style="flex-wrap:wrap"><button class="btn quiet sm" data-a="tAsk">${t.live === 'asking' ? 'Asking the chain…' : t.live ? `Chain says: ${esc(t.live)}` : 'Ask the real chip'}</button><button class="btn quiet sm" data-a="tRefresh">Refresh price</button><button class="btn primary sm" data-a="tCreate">Create this vault</button></div></div>
        <p class="fine">Assumes your vault is funded, inside its limits and not paused. A real vault re-checks all of this, plus the worst fill price, at the moment of the trade.</p>
      </div>
    </div></section>`;
}

/* ---------- Activity ---------- */
function histTable(rows) {
  return `<div class="scroll"><table class="hist"><thead><tr><th>Trade</th><th>Paid</th><th>Received</th><th>Size</th><th>Avg price</th><th>Transaction</th></tr></thead><tbody>${rows.map((x) => `<tr>
    <td>${x.dir === 0 ? 'Buy' : 'Take profit'}</td><td class="num">${amt(x.inn, x.dir)}</td><td class="num">${outAmt(x.out, x.dir)}</td>
    <td class="num">${x.version === 2 ? x.k + '×' : 'fixed'}</td><td class="num">${price6(x.price)}</td><td>${link(x.hash, 'tx')}</td></tr>`).join('')}</tbody></table></div>`;
}
function feedList(rows) {
  return `<ul class="feed">${rows.map((f) => `<li><span class="tag ${f.dir === 0 ? 'buy' : 'sell'}">${f.dir === 0 ? 'Bought' : 'Sold'}</span>
    <span class="what"><b class="num">${f.dir === 0 ? okb(f.out, 4) : okb(f.inn, 4)} OKB</b> <span class="muted">for <span class="num">${f.dir === 0 ? usd(f.inn) : usd(f.out)}</span> USDT0</span></span>
    <span class="meta"><span class="kx">${f.version === 2 ? 'chip ' + f.k + '×' : 'chip checked'}</span>${link(f.hash, 'tx', 'transaction')}</span></li>`).join('')}</ul>`;
}
function pageActivity() {
  const n = S.net;
  return `<section class="wrap block"><h1 class="pg">Activity</h1>
    <dl class="facts wide">
      <div><dt>Trades checked by chip</dt><dd class="num">${n ? n.trades : '…'}</dd></div>
      <div><dt>OKB bought</dt><dd class="num">${n ? okb(n.okb, 4) : '…'}</dd></div>
      <div><dt>USDT0 spent on OKB</dt><dd class="num">${n ? usd(n.usdtIn) : '…'}</dd></div>
      <div><dt>Profit taken (USDT0)</dt><dd class="num">${n ? usd(n.profit) : '…'}</dd></div>
      <div><dt>Vaults</dt><dd class="num">${n ? `${n.vaults}` : '…'}</dd></div>
    </dl>
    <h2 class="sub">Latest trades on X Layer</h2>
    ${S.feed == null ? '<p class="muted">Loading trades from the chain…</p>' : S.feed.length ? feedList(S.feed) : '<p class="muted">No trades yet.</p>'}
    <p class="fine">Read live from the chain. Contracts: ${HAS2 ? link(C.factory2, 'address', 'vault factory') + ' · ' : ''}${link(C.factory, 'address', 'classic factory')} · ${link(C.processor, 'address', 'TapeOut processor')}</p></section>`;
}

/* ---------- Safety ---------- */
const AGENT_VAULT = '0x367F3EB73E6C5e7883Aa7D1db76Cb29C11E710b7';
function pageAgents() {
  const cmd = (t) => `<pre class="cmd"><code>${esc(t)}</code></pre>`;
  return `<section class="wrap block"><h1 class="pg">Agents</h1>
    <p class="lead-s">Two kinds of agent work with Latch. Neither can take your money: the vault and the chip enforce every rule, whoever asks.</p>
    <div class="split">
      <div><h2>Latch's agent runs your vault</h2>
        <p>Every minute, Latch's agent asks each vault whether to trade. If the chip says yes, it sends the trade and pays the gas. It follows your rules; it cannot change them.</p>
        <ul class="plain"><li>It can only trigger trades your rules allow, at your prices, into your wallet</li><li>It can't withdraw, raise a limit or change where money goes</li><li>Prefer your own? Pick “Use my own agent” when you create a vault</li></ul>
      </div>
      <div><h2>Your AI agent can manage vaults for you</h2>
        <p>With the <b>OKX Agentic Wallet</b>, an AI assistant (Claude Code, Cursor, Codex and others) creates and manages Latch vaults when you ask in plain words. The wallet keeps the keys; the AI never sees them, and you confirm every step that moves money.</p>
        <p class="fine">Live on mainnet: an OKX Agentic Wallet created vault ${link(AGENT_VAULT)} this way.</p>
      </div>
    </div>
    <h2 class="sub">Set it up</h2>
    <ol class="steps-l">
      <li>Set up the OKX Agentic Wallet (OKX's Onchain OS) with your AI assistant.</li>
      <li>Add the Latch skill:${cmd('npx skills add sollid-web/latch')}</li>
      <li>Ask in plain words. For example:</li>
    </ol>
    <div class="chat">
      <p class="you">Make me a Latch vault that buys OKB on dips. 1 USDT0 a time, never above $100.</p>
      <p class="ai">OKB is 82.10 now. A Smart vault would buy 1 USDT0 today and more on bigger dips, at most 3 USDT0 a day. Create it? You'll confirm in your Agentic Wallet.</p>
      <p class="you">Yes. Then add 5 USDT0.</p>
      <p class="ai">Done: vault 0x…, funded with 5 USDT0. Latch's agent checks it every minute.</p>
    </div>
    <p class="fine">Illustrative conversation. The assistant uses the <code>latch</code> tool: check the market, preview the chip, create, fund, pause, change strategy, withdraw. The tool only prepares transactions; the Agentic Wallet signs them after you confirm.</p>
    <h2 class="sub">What an AI agent can't do</h2>
    <ul class="plain"><li>Spend more than your per-trade and daily limits, or pay above your ceiling</li><li>Send the output anywhere but the wallet fixed when the vault was made</li><li>Take money out of a vault it doesn't own</li></ul>
    <p class="mt"><a href="${esc(C.repo)}/tree/main/plugin/latch-plugin" target="_blank" rel="noopener">The Latch skill and tool, with its source</a></p>
  </section>`;
}

function pageSafety() {
  return `<section class="wrap block"><h1 class="pg">Safety</h1><div class="split">
    <div><h2>What a stolen agent key could do</h2>
      <p>Most trading bots and agents hold your keys. If they are hacked, your account is emptied. With Latch, the worst a stolen agent key can do is trigger the trades your own rules already allow, at your prices, into your own wallet. Latch can also switch an agent key off for every vault at once; that switch can only stop trades, never move funds.</p>
      <p>The vault refuses a trade if Uniswap's live price is more than about 1% away from its 30-minute average, or if the worst accepted fill would break your ceiling or floor. Latch's agent also refuses when Uniswap disagrees with the major exchanges.</p></div>
    <div><h2>What only you can do</h2>
      <ul class="plain"><li>Withdraw everything, any time, even while paused</li><li>Pause and resume</li><li>Change the strategy, reference price, ceiling or floor, and spacing</li><li>Lower your limits (they can never be raised) or switch to your own agent</li></ul>
      <h2 class="sub">Checked and open</h2><p>Open-source contracts. Tests against Uniswap's real contract code (47 for the vault, 34 for the agent), Slither static analysis, and three independent reviews by separate AI agents, with every finding fixed or answered in writing. This is not a professional audit: start small.</p>
      <p><a href="${C.repo}" target="_blank" rel="noopener">Read the code, tests and reviews</a></p></div></div></section>
  <section class="wrap block split">
    <div><h2>Fees</h2><p>1% of each trade, falling to 0.75%, 0.5% and 0.25% as your vault's volume passes 1,000, 5,000 and 20,000 USDT0. Uniswap's pool keeps its own 0.05%. No sign-up, deposit or withdrawal fees. Latch's agent pays the gas.</p></div>
    <div><h2>Risks</h2><p>OKB's price can keep falling after you buy, or keep rising after you sell. USDT0's issuer can freeze addresses. Smart contracts can have bugs. Prices come from one Uniswap pool, protected by the 30-minute average and the live-price check.</p></div></section>
  <section class="wrap block faq"><h2>Questions</h2>
    <details><summary>Can Latch take my money?</summary><p>No. Only the wallet that created the vault can withdraw. Latch's agent can only trigger trades within your rules, into your wallet.</p></details>
    <details><summary>Why WOKB and not OKB?</summary><p>Uniswap trades the wrapped form of OKB. Each WOKB is always worth 1 OKB and can be unwrapped any time. Add the WOKB token in your wallet to see it.</p></details>
    <details><summary>What is the reference price?</summary><p>The price your strategy measures moves from. A Buy vault with reference 85 sees OKB at 76 as "10% below"; a Take Profit vault with reference 85 sees 98 as "15% above". You can change it any time.</p></details>
    <details><summary>Which wallet do I need?</summary><p>Any wallet that supports X Layer. On a computer: a wallet extension such as OKX Wallet or MetaMask, or scan the code with a wallet app on your phone. On a phone: the OKX Wallet app, another WalletConnect wallet, or open this page in your wallet app's browser.</p></details>
    <details><summary>What happens when the market is jumpy?</summary><p>Smart and ladder strategies trade only the base amount when the live price is 0.35–0.6% away from the 30-minute average, and pause beyond that. Every strategy stops at about 1%.</p></details>
  </section>`;
}

/* ================================================================ render */

function dialogView() {
  const g = S.dialog; if (!g) return '';
  const fields = (g.fields || []).map((f) => f.options
    ? `<label class="form">${esc(f.label)}<select id="dg-${f.id}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${String(f.value) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`
    : `<label class="form">${esc(f.label)}<input id="dg-${f.id}" type="number" step="any" inputmode="decimal" value="${esc(f.value)}">${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`).join('');
  return `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="dg-t"><form class="sheet small" data-form="dialog">
    <div class="row between"><h2 id="dg-t">${esc(g.title)}</h2><button type="button" class="x" data-a="closeDialog" aria-label="Close">×</button></div>
    ${g.text ? `<p class="dlg-text">${g.text}</p>` : ''}<div class="form">${fields}</div>
    ${S.error ? `<p class="err" role="alert">${esc(S.error)}</p>` : ''}
    ${g.kind === 'add' ? fundSteps(g.d) : ''}
    <div class="row end gap"><button type="button" class="btn quiet" data-a="closeDialog">Cancel</button><button type="submit" class="btn ${g.danger ? 'danger' : 'primary'}" ${S.busy ? 'disabled' : ''}>${S.busy ? esc(S.busy) + '…' : esc(g.ok)}</button></div>
  </form></div>`;
}

const WALLET_ICON = `<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 9h15a3 3 0 0 1 3 3" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="16.5" cy="13.5" r="1.3" fill="currentColor"/></svg>`;
const SCAN_ICON = `<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M4 9V5h4M16 5h4v4M20 15v4h-4M8 19H4v-4" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="8" y="8" width="3" height="3" fill="currentColor"/><rect x="13" y="8" width="3" height="3" fill="currentColor"/><rect x="8" y="13" width="3" height="3" fill="currentColor"/><rect x="13" y="13" width="3" height="3" fill="currentColor"/></svg>`;
const PHONE_ICON = `<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 18.5h3" stroke="currentColor" stroke-width="1.6"/></svg>`;
function pickerView() {
  const pk = S.picker; if (!pk) return '';
  const mobile = isMobile();
  const option = (id, icon, name, hint) => `<li><button class="wopt" data-a="pick" data-id="${esc(id)}" ${pk.busy ? 'disabled' : ''}>
      <span class="wico">${icon}</span><span class="wtxt"><b>${esc(name)}</b>${hint ? `<small>${hint}</small>` : ''}</span></button></li>`;
  let body;
  if (pk.step === 'wc') {
    body = `<p class="dlg-text">Open your wallet app on your phone and scan this code with its scanner. It works with OKX Wallet, Bitget Wallet, MetaMask, Trust Wallet and other WalletConnect wallets that support X Layer.</p>
      <div class="qr" aria-label="WalletConnect code">${pk.qr || `<span class="muted">${esc(pk.busy || 'Making a code')}…</span>`}</div>
      ${pk.uri ? `<div class="row gap wrapr">${mobile ? `<a class="btn primary sm" href="${esc(pk.uri)}">Open wallet app</a>` : ''}<button class="btn quiet sm" data-a="copyWc">${pk.copied ? 'Copied' : 'Copy code as a link'}</button></div>
        <p class="fine">After you approve in the wallet, this page connects by itself. ${mobile ? 'On this phone, “Open wallet app” asks which wallet to use.' : ''}</p>` : ''}
      <div class="row between"><button class="btn quiet sm" data-a="wcBack">Back</button></div>`;
  } else {
    const inj = browserWallets();
    const list = inj.map((w) => option(w.id, w.icon ? `<img src="${esc(w.icon)}" alt="" width="28" height="28">` : WALLET_ICON, w.name, '')).join('');
    const scan = hasWalletConnect() ? option('wc', SCAN_ICON, mobile ? 'Other wallet apps' : 'Scan with a phone wallet', mobile ? 'Bitget, MetaMask, Trust and other WalletConnect wallets' : 'QR code for OKX Wallet, Bitget, MetaMask, Trust and other WalletConnect wallets') : '';
    const okxApp = mobile && !C.onchain ? option('okx', PHONE_ICON, 'OKX Wallet app', 'Opens the app to approve, then brings you back') : '';
    body = `${inj.length ? `<h3 class="wgrp">In this browser</h3><ul class="wlist">${list}</ul>` : `<p class="fine">${mobile ? 'No wallet in this browser.' : 'No wallet extension found in this browser. Install OKX Wallet, MetaMask or another wallet extension and reload, or scan with your phone.'}</p>`}
      ${scan || okxApp ? `<h3 class="wgrp">${mobile ? 'Wallet apps' : 'On your phone'}</h3><ul class="wlist">${okxApp}${scan}</ul>` : ''}
      ${mobile ? `<details class="wmore"><summary>Open Latch inside your wallet app instead</summary>
        <p class="fine">Open the wallet app, go to its browser (Discover), and open this page there. Then tap Connect wallet.</p>
        <div class="row gap wrapr"><a class="btn quiet sm" href="${esc(okxWalletLink())}" rel="noopener">OKX Wallet app</a><a class="btn quiet sm" href="${esc(okxAppLink())}" rel="noopener">OKX app</a><button class="btn quiet sm" data-a="copyLink">${S.copied ? 'Link copied' : 'Copy page link'}</button></div></details>` : ''}
      <p class="fine">Latch runs on X Layer (chain 196). Your wallet needs to support it. Connecting only shares your address; every action asks you to approve it in your wallet.</p>`;
  }
  return `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="pk-t"><div class="sheet small picker">
    <div class="row between"><h2 id="pk-t">${pk.step === 'wc' ? 'Scan with your wallet' : 'Connect a wallet'}</h2><button type="button" class="x" data-a="closePicker" aria-label="Close">×</button></div>
    ${pk.busy && pk.step !== 'wc' ? `<p class="note-in" role="status">${esc(pk.busy)}…</p>` : ''}
    ${pk.error ? `<p class="err" role="alert">${esc(pk.error)}</p>` : ''}
    ${body}</div></div>`;
}

function mobileHelp() {
  if (!S.mobileHelp) return '';
  return `<section class="wrap note" role="status"><p><b>Open Latch inside your wallet app.</b> Phone browsers can't connect to a wallet directly.</p>
    <ol class="terms" style="margin-top:8px"><li>Tap <b>Open in OKX Wallet app</b> (the Web3 wallet). If your wallet is inside the OKX exchange app, tap <b>Open in OKX app</b>. If nothing opens, tap <b>Copy link</b>.</li><li>Open the <b>OKX Wallet</b> app (or the OKX app, then switch to <b>Wallet</b>).</li><li>Go to <b>Discover</b> (the browser), paste the link and open it.</li><li>Tap <b>Connect wallet</b> there.</li></ol>
    <div class="row gap" style="flex-wrap:wrap"><a class="btn primary sm" href="${esc(okxWalletLink())}" rel="noopener">Open in OKX Wallet app</a><a class="btn quiet sm" href="${esc(okxAppLink())}" rel="noopener">Open in OKX app</a><button class="btn quiet sm" data-a="copyLink">${S.copied ? 'Link copied' : 'Copy link'}</button><button class="btn quiet sm" data-a="hideHelp">Close</button></div></section>`;
}

function render() {
  saveDraft();
  const app = document.getElementById('app');
  const focus = document.activeElement?.id;
  const page = { home: pageHome, try: pageTry, create: pageCreate, vaults: pageVaults, chip: pageChip, activity: pageActivity, agents: pageAgents, safety: pageSafety }[S.page] || pageHome;
  app.innerHTML = header() + `<main id="main">${mobileHelp()}${S.note ? `<p class="wrap note" role="status">${esc(S.note)}</p>` : ''}${page()}</main>
    <footer class="wrap foot"><span>${C.onchain ? 'You are on the on-chain copy of Latch, served from X Layer (DeWEB). ' : ''}Latch runs on X Layer. Every trade is decided by TapeOut circuit #${CID2}${C.circuitId ? ` (classic vaults: #${C.circuitId})` : ''}.${!C.onchain && C.deweb ? ` Also on chain: <a href="${esc(C.deweb.url)}" target="_blank" rel="noopener">${esc(C.deweb.name)}</a>.` : ''}</span><span>${HAS2 ? link(C.factory2, 'address', 'Vault factory') + ' · ' : ''}<a href="${C.repo}" target="_blank" rel="noopener">GitHub</a></span></footer>` + dialogView() + pickerView();
  if (focus) document.getElementById(focus)?.focus();
  if (S.dialog && !focus) document.querySelector('.sheet input, .sheet select')?.focus();
}

/* ================================================================ routing */

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [p, q] = h.split('?');
  const page = PAGES.some(([id]) => id === p) ? p : 'home';
  const changed = page !== S.page;
  const first = !S.routed; S.routed = true;
  S.page = page; S.error = '';
  if (page === 'create' && (q === 'buy' || q === 'sell')) { S.c = newCreate(q === 'buy' ? 0 : 1); history.replaceState(null, '', '#/create'); }
  else if (page === 'create' && (!S.c || (S.c.step === 4 && !first)) && changed) S.c = newCreate(null);
  render();
  if (changed) window.scrollTo(0, 0);
  if (page === 'try' && (!S.t.mkt || Date.now() - S.t.mkt.at > 60_000)) readLive().then((m) => { S.t.mkt = m; render(); }).catch(() => {});
}
window.addEventListener('hashchange', route);

/* ================================================================ actions */

function readCreateForm() {
  const c = S.c; if (!c) return;
  document.querySelectorAll('[data-c]').forEach((el) => { c[el.dataset.c] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
}
function validateCreate(c) {
  const dec = c.dir === 0 ? 6 : 18;
  let base, perTx, daily;
  try { base = parseUnits(c.base || '0', dec); perTx = parseUnits(c.perTx || '0', dec); daily = parseUnits(c.daily || '0', dec); } catch { return 'Check the amounts: use numbers only.'; }
  const min = c.dir === 0 ? S.mins.buy : S.mins.sell;
  if (base < min) return `The base amount must be at least ${c.dir === 0 ? usd(min) + ' USDT0' : okb(min, 4) + ' OKB'}.`;
  if (perTx < base) return 'Most per trade must be at least the base amount.';
  if (daily < perTx) return 'Most per day must be at least the most per trade.';
  if (!(Number(c.ref) > 0)) return 'Enter a reference price above 0.';
  if (!(Number(c.limit) > 0)) return `Enter a ${c.dir === 0 ? 'ceiling' : 'floor'} price above 0.`;
  if (!isAddress(c.savings)) return 'The "Send to" address is not valid.';
  if (S.treasury && c.savings.toLowerCase() === S.treasury.toLowerCase()) return 'That wallet is Latch’s fee wallet. Choose another wallet to receive the output.';
  if (c.ownBot && !isAddress(c.botAddr)) return 'Your agent address is not valid.';
  return '';
}
/** The two ways to put money in a vault, spelled out. */
function fundSteps(d) {
  const tok = d.version === 2 && d.dir === 1 ? 'WOKB' : 'USDT0';
  const alias = tok === 'USDT0' ? ' (some wallets call it USDT)' : ' (wrapped OKB)';
  return `<div class="howto">
    <p class="howto-t">Two ways to add money</p>
    <p class="howto-s"><b>1. From this page:</b> enter an amount above and tap <i>Add ${tok}</i>. Your wallet asks you to approve; nothing moves until you do.${C.depositor ? ` The first time, it also asks you to approve Latch's deposit helper, which only moves your own ${tok}, only into Latch vaults, and only when you ask.` : ''} If your wallet answers with an error, use way 2.</p>
    ${C.depositor ? `<p class="fine">Your wallet may call this “Approve Unknown”: it just doesn't have a name for the helper yet. Check the address it shows is ${link(C.depositor)} (source published and verified). It may ask how much to approve: <i>Unlimited</i> approves once; the amount you're adding approves just this time.</p>` : ''}
    <p class="howto-s"><b>2. From your wallet app:</b></p>
    <ol class="howto-l">
      <li>Copy this vault's own address. Every vault has its own, and this is not your wallet's address:<span class="addrbox"><span class="hex">${esc(d.address)}</span><button type="button" class="btn quiet sm" data-a="copyAddr" data-addr="${d.address}">${S.copiedAddr === d.address ? 'Copied' : 'Copy'}</button></span></li>
      <li>In your wallet app, tap <b>Send</b> and pick <b>${tok}</b>${alias} on the <b>X Layer</b> network.</li>
      <li>Paste the address, enter the amount, and confirm.</li>
      <li>Come back here and tap <b>Refresh</b>. The balance shows within a minute.</li>
    </ol>
    <p class="fine">Send only ${tok} on X Layer. Money sent on another network does not reach the vault. Only you can take it out again, with <i>Withdraw all</i>.</p>
  </div>`;
}
function openDialog(d) { S.error = ''; S.dialog = d; render(); }
const dlg = (id) => document.getElementById('dg-' + id)?.value?.trim();

async function runDialog() {
  const g = S.dialog; if (!g) return;
  const d = g.d; let r = null;
  try {
    if (g.kind === 'add') {
      g.fields[0].value = dlg('amt') || '0'; // keep what was typed through re-renders
      r = await addFunds(d.address, d.version === 2 ? d.tokenIn : C.usdt, parseUnits(g.fields[0].value, d.version === 2 && d.dir === 1 ? 18 : 6), { normalFee: !!g.retry });
      if (!r && S.sendErr && !declined(S.sendErr)) { // e.g. the wallet's free-gas service answered "network error"
        if (!g.retry) { g.retry = true; g.ok = 'Try again with a normal fee'; S.error = 'Your wallet could not send it. Try again with a normal network fee (a fraction of a cent in OKB), or send from your wallet app with the vault address below.'; }
        else S.error = 'Your wallet still could not send it. Copy the vault address below and send ' + (d.version === 2 && d.dir === 1 ? 'WOKB' : 'USDT0') + ' on X Layer from your wallet app; it lands in the vault the same way.';
        return render();
      }
    }
    if (g.kind === 'strategy') {
      const dec = d.dir === 0 ? 6 : 18;
      const base = parseUnits(dlg('base') || '0', dec);
      if (base > d.perTxCap) { S.error = `The base amount can be at most your per-trade limit (${amt(d.perTxCap, d.dir)}).`; return render(); }
      r = await send('Saving strategy', { address: d.address, abi: VAULT2, functionName: 'setStrategy',
        args: [base, d.perTxCap, d.dailyCap, parseUnits(dlg('ref') || '0', 6), parseUnits(dlg('limit') || '0', 6), BigInt(dlg('spacing') || '0'), Number(dlg('mode'))] });
    }
    if (g.kind === 'withdraw') {
      if (d.version === 1) r = await send('Withdrawing', { address: d.address, abi: VAULT1, functionName: 'withdraw', args: [C.usdt, S.account, MAX] });
      else {
        for (const [t, bal] of [[d.tokenIn, d.balance], [d.tokenOut, d.stuck]]) {
          if (bal > 0n) { r = await send('Withdrawing', { address: d.address, abi: VAULT2, functionName: 'withdraw', args: [t, S.account, MAX] }); if (!r) break; }
        }
      }
    }
  } catch (e) { S.error = plain(e); render(); return; }
  if (r) { S.dialog = null; await refresh(); }
}

async function act(a, el) {
  const card = el.closest('[data-v]'); const v = card?.dataset.v;
  const d = [...S.v2, ...S.v1].find((x) => x.address === v);
  S.error = '';
  const c = S.c;
  switch (a) {
    case 'connect': return connect();
    case 'refresh': return refresh();
    case 'disconnect': await disconnect(); S.v1 = []; S.v2 = []; S.dialog = null; render(); return refresh();
    case 'hideHelp': S.mobileHelp = false; return render();
    case 'copyAddr': {
      const addr = el.dataset.addr;
      try { await navigator.clipboard.writeText(addr); S.copiedAddr = addr; } catch { window.prompt('Copy the vault address:', addr); }
      setTimeout(() => { S.copiedAddr = null; render(); }, 2500);
      return render();
    }
    case 'copyVault': {
      const addr = S.dialog?.d?.address; if (!addr) return;
      try { await navigator.clipboard.writeText(addr); S.copiedVault = true; } catch { window.prompt('Copy the vault address:', addr); }
      setTimeout(() => { S.copiedVault = false; render(); }, 2500);
      return render();
    }
    case 'copyLink': {
      try { await navigator.clipboard.writeText(location.href); S.copied = true; } catch { window.prompt('Copy this link:', location.href); }
      return render();
    }
    /* chip explorer */
    case 'x': {
      const k = el.dataset.k; S.x[k] = Number(el.dataset.v); S.x.live = null;
      if (k === 'dir' && S.x.mode > 3) S.x.mode = 0;
      return render();
    }
    case 'xs': S.x.safety ^= 1 << Number(el.dataset.bit); S.x.live = null; return render();
    case 'askChip': {
      S.x.live = 'asking'; render();
      const input = pack(S.x);
      try {
        const out = await pub.readContract({ address: C.processor, abi: PROC, functionName: 'eval', args: [BigInt(CID2), '0x' + (input & 0xff).toString(16).padStart(2, '0') + (input >> 8).toString(16).padStart(2, '0')] });
        const o = parseInt(out.slice(2, 4), 16);
        S.x.live = o & 1 ? `${S.x.dir === 0 ? 'buy' : 'sell'} ${(o >> 1) & 3}×` : 'wait';
      } catch { S.x.live = 'no answer (connection)'; }
      return render();
    }
    /* try it */
    case 't': {
      const k = el.dataset.k; const v = Number(el.dataset.v);
      if (k === 'dir' && v !== S.t.dir) { S.t.dir = v; S.t.ref = ''; S.t.limit = ''; S.t.base = v === 0 ? '2' : '0.02'; }
      else S.t[k] = v;
      S.t.live = null; return render();
    }
    case 'tRefresh': S.t.mkt = null; render(); try { S.t.mkt = await readLive(); } catch { S.error = 'Could not read the pool right now.'; } return render();
    case 'tAsk': {
      const r = tryDecision(S.t); if (!r) return;
      S.t.live = 'asking'; render();
      try {
        const out = await pub.readContract({ address: C.processor, abi: PROC, functionName: 'eval', args: [BigInt(CID2), '0x' + (r.input & 0xff).toString(16).padStart(2, '0') + (r.input >> 8).toString(16).padStart(2, '0')] });
        const o = parseInt(out.slice(2, 4), 16);
        S.t.live = o & 1 ? `${S.t.dir === 0 ? 'buy' : 'sell'} ${(o >> 1) & 3}×` : 'wait';
      } catch { S.t.live = 'no answer (connection)'; }
      return render();
    }
    case 'tCreate': {
      const t = S.t; S.c = newCreate(t.dir); S.c.mode = t.mode; S.c.base = t.base; S.c.ref = t.ref; S.c.limit = t.limit; S.c.limitsTouched = false; suggestLimits(S.c);
      location.hash = '#/create'; return;
    }
    /* create */
    case 'cdir': c.dir = Number(el.dataset.v); c.limitsTouched = false; setDefaults(c); return render();
    case 'cmode': c.mode = Number(el.dataset.v); suggestLimits(c); return render();
    case 'cback': readCreateForm(); c.step--; return render();
    case 'cnext': {
      if (c.step === 0 && !S.account) { await connect(); if (!S.account) return; c.savings = c.savings || S.account; }
      if (c.step === 2) { readCreateForm(); const e = validateCreate(c); if (e) { S.error = e; return render(); } }
      if (c.step === 1 && !c.savings && S.account) c.savings = S.account;
      c.step++; return render();
    }
    case 'ccreate': {
      const dec = c.dir === 0 ? 6 : 18;
      try { c.before = (await pub.readContract({ address: C.factory2, abi: FACTORY2, functionName: 'vaultsOf', args: [S.account] })).length; c.by = S.account; saveDraft(); } catch {}
      const r = await send('Creating your vault', {
        address: C.factory2, abi: FACTORY2, functionName: 'createVault',
        args: [c.dir, c.mode, getAddress(c.savings), parseUnits(c.base, dec), parseUnits(c.perTx, dec), parseUnits(c.daily, dec),
          parseUnits(c.ref, 6), parseUnits(c.limit, 6), BigInt(c.spacing), c.ownBot ? getAddress(c.botAddr) : ZERO]
      });
      if (!r) return;
      const list = await pub.readContract({ address: C.factory2, abi: FACTORY2, functionName: 'vaultsOf', args: [S.account] });
      c.created = list[list.length - 1]; c.step = 4; c.before = null;
      await readMine(); return render();
    }
    case 'cwrap': {
      readCreateForm();
      const want = parseUnits(c.deposit || '0', 18);
      const have = S.wallet?.wokb ?? 0n;
      const need = want > have ? want - have : 0n;
      if (need === 0n) { S.note = 'You already hold enough WOKB for this deposit.'; return render(); }
      const r = await send('Wrapping OKB', { address: C.wokb, abi: WOKB_ABI, functionName: 'deposit', value: need });
      if (r) { await readMine(); render(); }
      return;
    }
    case 'cdeposit': {
      readCreateForm();
      const dec = c.dir === 0 ? 6 : 18;
      let amount; try { amount = parseUnits(c.deposit || '0', dec); } catch { amount = 0n; }
      if (amount <= 0n) { S.error = 'Enter an amount above 0.'; return render(); }
      const r = await addFunds(c.created, c.dir === 0 ? C.usdt : C.wokb, amount);
      if (r) { S.c = null; location.hash = '#/vaults'; await refresh(); }
      return;
    }
    /* vault actions */
    case 'vadd': {
      const two = d.version === 2;
      const tok = two ? (d.dir === 0 ? 'USDT0' : 'WOKB') : 'USDT0';
      const bal = two && d.dir === 1 ? S.wallet?.wokb : S.wallet?.usdt;
      return openDialog({ kind: 'add', d, title: 'Add ' + tok, ok: 'Add ' + tok,
        fields: [{ id: 'amt', label: `Amount (${tok})`, value: two && d.dir === 1 ? '0.05' : '5', hint: bal != null ? `Your wallet holds ${two && d.dir === 1 ? okb(bal, 4) : usd(bal)} ${tok}.` : '' }] });
    }
    case 'vpause': case 'vresume': {
      const r = await send(a === 'vpause' ? 'Pausing' : 'Resuming', { address: v, abi: d.version === 2 ? VAULT2 : VAULT1, functionName: 'setPaused', args: [a === 'vpause'] });
      if (r) await refresh(); return;
    }
    case 'vstrategy': {
      const dec = d.dir === 0 ? 6 : 18;
      return openDialog({ kind: 'strategy', d, title: 'Change strategy', ok: 'Save strategy', fields: [
        { id: 'mode', label: 'Strategy', value: d.mode, options: MODES[d.dir].map((m, i) => [i, `${m.name}: ${m.short}`]) },
        { id: 'base', label: `Base amount per trade (${d.dir === 0 ? 'USDT0' : 'OKB'})`, value: formatUnits(d.baseAmount, dec), hint: `At most your per-trade limit, ${amt(d.perTxCap, d.dir)}.` },
        { id: 'ref', label: 'Reference price', value: formatUnits(d.refPrice, 6), hint: `OKB is ${P(S.price)} now.` },
        { id: 'limit', label: d.dir === 0 ? 'Never pay more than' : 'Never sell under', value: formatUnits(d.limitPrice, 6) },
        { id: 'spacing', label: 'How often, at most', value: String(d.minInterval), options: [['3600', 'Every hour'], ['86400', 'Every day'], ['604800', 'Every week'], ['0', 'Whenever the chip allows'], ...(['0', '3600', '86400', '604800'].includes(String(d.minInterval)) ? [] : [[String(d.minInterval), spacingText(d.minInterval)]])] }
      ] });
    }
    case 'vwithdraw': {
      const what = d.version === 2 ? amt(d.balance, d.dir) : usd(d.balance) + ' USDT0';
      return openDialog({ kind: 'withdraw', d, title: 'Withdraw everything', ok: 'Withdraw all', danger: true,
        text: `${esc(what)} goes back to your wallet ${esc(short(S.account))}. Pause first if you also want trading to stop.` });
    }
    case 'closeDialog': S.dialog = null; return render();
    case 'pick': return choose(el.dataset.id);
    case 'closePicker': return closePicker();
    case 'wcBack': cancelWc(); return render();
    case 'copyWc': {
      try { await navigator.clipboard.writeText(S.picker.uri); S.picker.copied = true; } catch { window.prompt('Copy this link:', S.picker.uri); }
      return render();
    }
  }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]'); if (!el || el.disabled) return;
  if (el.tagName === 'INPUT') return;
  e.preventDefault(); act(el.dataset.a, el);
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset?.a === 'xr') { S.x[el.dataset.k] = Number(el.value); S.x.live = null; render(); document.querySelector('[data-a=xr]')?.focus(); return; }
  if (el.dataset?.t) { S.t[el.dataset.t] = el.value.trim(); S.t.live = null; return; }
  if (el.dataset?.c && S.c) {
    S.c[el.dataset.c] = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (el.dataset.c === 'perTx' || el.dataset.c === 'daily') S.c.limitsTouched = true;
    saveDraft();
  }
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset?.c === 'base' && S.c) { suggestLimits(S.c); render(); }
  if (el.dataset?.t) render(); // Try it: recompute when a field is done
});
document.addEventListener('submit', (e) => { if (e.target.matches('[data-form=dialog]')) { e.preventDefault(); runDialog(); } });
document.addEventListener('toggle', (e) => { const k = e.target?.dataset?.k; if (k) S.open[k] = e.target.open; }, true);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (S.picker) return closePicker();
  if (S.dialog && !S.busy) { S.dialog = null; render(); }
});

S.c = loadDraft();
route();
refresh();
restoreSession().then((ok) => { if (ok) refresh(); }); // already approved in the OKX Wallet app → show connected
setInterval(() => { if (!S.busy && !S.dialog && S.page !== 'create') refresh(); }, 60_000);
window.__latch = S; window.__latchRender = render; // for tests and debugging
