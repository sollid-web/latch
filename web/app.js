// Latch web app — create a vault, fund it, watch it buy OKB, pause or withdraw.
// Bundled into public/index.html by scripts/build-web.mjs (esbuild). No server.
import {
  createPublicClient, createWalletClient, custom, fallback, http, parseAbi, parseAbiItem,
  formatUnits, parseUnits, getAddress, isAddress, decodeErrorResult
} from 'viem';

const C = window.LATCH_CONFIG;
const U6 = 10n ** 6n;
const MAX = 2n ** 256n - 1n;

const chain = {
  id: C.chainId, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: C.rpc } }, blockExplorers: { default: { name: 'OKLink', url: C.explorer } }
};
const pub = createPublicClient({ chain, transport: fallback(C.rpc.map((u) => http(u, { timeout: 12_000 }))) });

const FACTORY = parseAbi([
  'function createVault(address savings,uint256 perTxCap,uint256 dailyCap,uint256 maxPrice,uint256 minInterval,address keeper) returns (address)',
  'function vaultsOf(address owner) view returns (address[])',
  'function vaultCount() view returns (uint256)',
  'function hostedKeeper() view returns (address)',
  'function vaultsPage(uint256 start, uint256 count) view returns (address[])',
  'event VaultCreated(address indexed owner, address indexed vault, address keeper, uint256 perTxCap, uint256 dailyCap, uint256 maxPrice, uint256 minInterval)'
]);
const VAULT = parseAbi([
  'function owner() view returns (address)',
  'function keeper() view returns (address)',
  'function savings() view returns (address)',
  'function paused() view returns (bool)',
  'function armed() view returns (bool)',
  'function perTxCap() view returns (uint256)',
  'function dailyCap() view returns (uint256)',
  'function maxPrice() view returns (uint256)',
  'function minInterval() view returns (uint256)',
  'function nextBuyAt() view returns (uint256)',
  'function lastBuyAt() view returns (uint256)',
  'function volumeSwept() view returns (uint256)',
  'function totalBought() view returns (uint256)',
  'function buys() view returns (uint256)',
  'function feeBpsNow() view returns (uint256)',
  'function status() view returns (address,bool,bool,uint256,uint256,uint256,uint256,address,address,address)',
  'function preview(uint256 amount) view returns (uint8 bits, bool allow)',
  'function quote(uint256 amount) view returns (uint256 twapPrice, uint256 expectedOut, uint256 minOut)',
  'function circuitAllows(uint8 bits) view returns (bool)',
  'function setPaused(bool next)',
  'function setMaxPrice(uint256 next)',
  'function setMinInterval(uint256 secs)',
  'function setCaps(uint256 perTxCap, uint256 dailyCap)',
  'function withdraw(address token, address to, uint256 amount)',
  'error NotOwner()', 'error NotKeeper()', 'error Paused()', 'error OverCap()', 'error Underfunded()',
  'error BadParam()', 'error CapRaised()', 'error BadRecipient()', 'error ZeroAddress()', 'error TooSoon(uint256)',
  'error PriceTooHigh(uint256,uint256)', 'error PriceUnstable()', 'error CircuitDenied(uint8)', 'error NotArmed()', 'error BadSavings()'
]);
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)'
]);
const POOL = parseAbi(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function token0() view returns (address)']);
const BOUGHT = parseAbiItem('event Bought(address indexed keeper, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 twapPrice, uint8 bits)');

const ERRORS_PLAIN = {
  NotOwner: 'Only the vault owner can do that. Connect the wallet that created this vault.',
  Underfunded: 'Not enough USDT0 for that.',
  BadParam: 'That value is outside the allowed range.',
  CapRaised: 'Limits can only be lowered, never raised. That is a safety rule.',
  BadRecipient: 'That wallet cannot receive OKB from a vault (it is a system contract). Use your own wallet address.',
  ZeroAddress: 'An address is missing.',
  OverCap: 'Amount per buy must be at least 1 USDT0 and not more than the daily limit.',
  BadSavings: 'That wallet cannot receive the OKB (it is Latch\u2019s fee wallet, a bot, or another vault). Choose another wallet address.'
};

/* ---------------------------------------------------------------- state */
const S = {
  account: null, walletChain: null, provider: null, walletName: '',
  price: null, vaultCount: null, hostedKeeper: null, circuitOk: null,
  vaults: [], loading: false, error: '', note: '',
  hist: {}, open: {}, netVaults: [], // buy history per vault, open <details>, vaults + last buy time
  blocks: new Map(), logsBusy: false, refreshing: false, // timestamp → block cache
  wizard: null, // {step, strategy, perBuy, price, perDay, every, savings, ownBot, botAddr, created, deposit}
  busy: '', txs: [], net: null, feed: null, dialog: null,
  chip: { bits: 0x7e, live: false } // hero circuit demo: the 7 inputs, editable
};

/* ---------------------------------------------------------------- wallet */
const announced = [];
window.addEventListener('eip6963:announceProvider', (e) => { if (e?.detail?.provider) announced.push(e.detail); });
try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch { /* old browsers */ }
function findWallet() {
  if (window.okxwallet) return { p: window.okxwallet, name: 'OKX Wallet' };
  const okx = announced.find((d) => /okx|okex/i.test(d.info?.rdns || d.info?.name || ''));
  if (okx) return { p: okx.provider, name: okx.info.name };
  if (window.ethereum) return { p: window.ethereum, name: 'Wallet' };
  if (announced[0]) return { p: announced[0].provider, name: announced[0].info?.name || 'Wallet' };
  return null;
}
const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');

async function connect() {
  let w = findWallet();
  if (!w) { await new Promise((r) => setTimeout(r, 900)); w = findWallet(); }
  if (!w) {
    if (isMobile()) {
      S.note = 'Opening Latch inside the OKX Wallet app…';
      render();
      location.href = 'okx://wallet/dapp/url?dappUrl=' + encodeURIComponent(location.href);
      setTimeout(() => { S.note = 'No wallet in this browser. Install OKX Wallet, then open this page from its Discover tab.'; render(); }, 2500);
    } else {
      S.note = 'No wallet found. Install the OKX Wallet browser extension, then reload this page.';
      render();
    }
    return;
  }
  S.provider = w.p; S.walletName = w.name; S.note = '';
  try {
    const accts = await w.p.request({ method: 'eth_requestAccounts' });
    S.account = accts?.[0] ? getAddress(accts[0]) : null;
    S.walletChain = Number(await w.p.request({ method: 'eth_chainId' }));
    if (S.walletChain !== C.chainId) await switchChain();
    if (w.p.on) {
      w.p.on('accountsChanged', (a) => { S.account = a?.[0] ? getAddress(a[0]) : null; refresh(); });
      w.p.on('chainChanged', (id) => { S.walletChain = Number(id); render(); });
    }
  } catch (e) {
    S.note = e?.code === 4001 ? 'You rejected the connection in your wallet.'
      : e?.code === -32002 ? 'Your wallet already has a request waiting. Open the wallet and answer it.'
      : plain(e);
  }
  await refresh();
}
async function switchChain() {
  const hex = '0x' + C.chainId.toString(16);
  try {
    await S.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    if (e?.code === 4902 || /Unrecognized chain/i.test(e?.message || '')) {
      await S.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: [C.rpc[0]], blockExplorerUrls: [C.explorer] }] });
    } else throw e;
  }
  S.walletChain = Number(await S.provider.request({ method: 'eth_chainId' }));
}
function wallet() {
  return createWalletClient({ account: S.account, chain, transport: custom(S.provider) });
}

/* ---------------------------------------------------------------- tx helper */
function plain(e) {
  const data = e?.cause?.data || e?.data || e?.cause?.cause?.data;
  const name = e?.cause?.data?.errorName || (() => {
    try { return typeof data === 'string' ? decodeErrorResult({ abi: VAULT, data }).errorName : null; } catch { return null; }
  })();
  if (name && ERRORS_PLAIN[name]) return ERRORS_PLAIN[name];
  if (e?.code === 4001 || /rejected|denied/i.test(e?.message || '')) return 'You cancelled it in your wallet.';
  return String(e?.shortMessage || e?.message || e).split('\n')[0];
}
async function send(label, req) {
  if (!S.account) return connect();
  if (S.walletChain !== C.chainId) { try { await switchChain(); } catch (e) { S.error = plain(e); render(); return null; } }
  S.busy = label; S.error = ''; render();
  try {
    await pub.simulateContract({ account: S.account, ...req });   // show the real reason before the wallet pops up
    const hash = await wallet().writeContract({ ...req, chain });
    S.txs.unshift({ label, hash, state: 'sent' }); render();
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    S.txs[0].state = r.status === 'success' ? 'done' : 'failed';
    if (r.status !== 'success') throw new Error(label + ' failed on chain');
    return r;
  } catch (e) {
    S.error = label + ': ' + plain(e);
    return null;
  } finally {
    S.busy = ''; render();
  }
}

/* ---------------------------------------------------------------- reads */
async function readMarket() {
  try {
    const [s0, t0] = await Promise.all([
      pub.readContract({ address: C.pool, abi: POOL, functionName: 'slot0' }),
      pub.readContract({ address: C.pool, abi: POOL, functionName: 'token0' })
    ]);
    const raw = Math.pow(1.0001, Number(s0[1]));
    S.price = t0.toLowerCase() === C.usdt.toLowerCase() ? 1e12 / raw : raw * 1e12;
  } catch { S.price = null; }
  try {
    const [n, k] = await Promise.all([
      pub.readContract({ address: C.factory, abi: FACTORY, functionName: 'vaultCount' }),
      pub.readContract({ address: C.factory, abi: FACTORY, functionName: 'hostedKeeper' })
    ]);
    S.vaultCount = Number(n); S.hostedKeeper = k;
  } catch { /* factory not reachable */ }
}

/** Network totals across every vault (social proof, read from chain). The latest-buys feed is
 *  loaded afterwards by loadLogs(), so these numbers never wait for log searches. */
async function readNetwork() {
  try {
    const all = await pub.readContract({ address: C.factory, abi: FACTORY, functionName: 'vaultsPage', args: [0n, 300n] });
    const per = await Promise.all(all.map((v) => Promise.all([
      pub.readContract({ address: v, abi: VAULT, functionName: 'totalBought' }),
      pub.readContract({ address: v, abi: VAULT, functionName: 'volumeSwept' }),
      pub.readContract({ address: v, abi: VAULT, functionName: 'buys' }),
      pub.readContract({ address: v, abi: VAULT, functionName: 'lastBuyAt' })
    ]).catch(() => [0n, 0n, 0n, 0n])));
    S.net = per.reduce((a, [o, i, b]) => ({ okb: a.okb + o, usdt: a.usdt + i, buys: a.buys + b }), { okb: 0n, usdt: 0n, buys: 0n });
    S.netVaults = all.map((v, i) => ({ vault: v, last: per[i][3] }));
  } catch { /* keep the last values */ }
}

/* ---------------------------------------------------------------- buy history (event logs)
 * The public X Layer RPC refuses eth_getLogs over more than 100 blocks, so every search is split
 * into 100-block pieces. Instead of scanning backwards blindly, each vault's own lastBuyAt tells
 * us when its latest buy happened; we find that block by its timestamp and search around it. */
const LOG_SPAN = 100n;

async function logsIn(address, from, to) {
  const ranges = [];
  for (let a = from; a <= to; a += LOG_SPAN) ranges.push([a, a + LOG_SPAN - 1n < to ? a + LOG_SPAN - 1n : to]);
  const out = [];
  for (let i = 0; i < ranges.length; i += 4) { // at most 4 requests at a time
    const parts = await Promise.all(ranges.slice(i, i + 4).map(([a, b]) => pub.getLogs({ address, event: BOUGHT, fromBlock: a, toBlock: b })));
    for (const p of parts) out.push(...p);
  }
  return out;
}

/** First block whose timestamp is >= ts (cached). Interpolation search, bisection as a fallback. */
async function blockAt(ts, head) {
  const key = ts.toString();
  if (S.blocks.has(key)) return S.blocks.get(key);
  if (ts >= head.timestamp) return head.number;
  let hi = { n: head.number, t: head.timestamp };
  let lo = null;
  for (let step = 1000n; ; step *= 4n) {
    const n = hi.n > step ? hi.n - step : 0n;
    const b = await pub.getBlock({ blockNumber: n });
    if (b.timestamp < ts) { lo = { n, t: b.timestamp }; break; }
    hi = { n, t: b.timestamp };
    if (n === 0n) { S.blocks.set(key, 0n); return 0n; }
  }
  for (let i = 0; i < 48 && hi.n - lo.n > 1n; i++) {
    let m = i % 2 === 0 && hi.t > lo.t
      ? lo.n + ((hi.n - lo.n) * (ts - lo.t)) / (hi.t - lo.t)
      : lo.n + (hi.n - lo.n) / 2n;
    if (m <= lo.n) m = lo.n + 1n;
    if (m >= hi.n) m = hi.n - 1n;
    const b = await pub.getBlock({ blockNumber: m });
    if (b.timestamp < ts) lo = { n: m, t: b.timestamp }; else hi = { n: m, t: b.timestamp };
  }
  S.blocks.set(key, hi.n);
  return hi.n;
}

/** Buys of one vault around its latest buy (newest first). `back` = how many blocks before it to include. */
async function buysOf(v, lastBuyAt, head, back = 1200n) {
  if (!lastBuyAt) return [];
  const b = await blockAt(lastBuyAt, head);
  const to = b + LOG_SPAN - 1n < head.number ? b + LOG_SPAN - 1n : head.number;
  const logs = await logsIn(v, b > back ? b - back : 0n, to);
  return logs.reverse().slice(0, 8).map((l) => ({ vault: l.address, hash: l.transactionHash, inn: l.args.amountIn, out: l.args.amountOut, fee: l.args.fee, bits: Number(l.args.bits), block: l.blockNumber }));
}

/** Runs after the page has its numbers: your vaults' recent buys, then the network feed. */
async function loadLogs() {
  if (S.logsBusy) return;
  S.logsBusy = true;
  try {
    const head = await pub.getBlock();
    for (const d of S.vaults) {
      try { S.hist[d.address] = await buysOf(d.address, d.lastBuyAt, head); }
      catch { if (S.hist[d.address] === undefined) S.hist[d.address] = null; }
      render();
    }
    const recent = S.netVaults.filter((x) => x.last > 0n).sort((a, b) => (b.last > a.last ? 1 : -1)).slice(0, 6);
    const feed = [];
    for (const x of recent) {
      try { const [latest] = await buysOf(x.vault, x.last, head, 0n); if (latest) feed.push(latest); } catch { /* skip this vault */ }
    }
    S.feed = feed.sort((a, b) => (b.block > a.block ? 1 : -1));
    render();
  } catch { /* keep the last values */ }
  finally { S.logsBusy = false; }
}

async function readVault(v) {
  const r = (fn, args = [], account) => pub.readContract({ address: v, abi: VAULT, functionName: fn, args, account });
  const [st, maxPrice, minInterval, nextBuyAt, lastBuyAt, spent, bought, buys, bps, usdtBal] = await Promise.all([
    r('status'), r('maxPrice'), r('minInterval'), r('nextBuyAt'), r('lastBuyAt'), r('volumeSwept'), r('totalBought'), r('buys'), r('feeBpsNow'),
    pub.readContract({ address: C.usdt, abi: ERC20, functionName: 'balanceOf', args: [v] })
  ]);
  const d = {
    address: v, paused: st[2], armed: st[1], balance: st[3], perTxCap: st[4], dailyCap: st[5], spentToday: st[6],
    keeper: st[7], savings: st[8], maxPrice, minInterval, nextBuyAt, lastBuyAt, spent, bought, buys, bps, usdtBal
  };
  let amount = d.perTxCap;
  const left = d.dailyCap > d.spentToday ? d.dailyCap - d.spentToday : 0n;
  if (amount > left) amount = left;
  const afford = (d.balance * 10000n) / (10000n + d.bps);
  if (amount > afford) amount = afford;
  d.nextAmount = amount;
  try {
    const [bits, allow] = await r('preview', [amount > 0n ? amount : d.perTxCap], d.keeper);
    d.bits = Number(bits); d.allow = allow;
    d.chip = await r('circuitAllows', [bits]);
  } catch (e) { d.previewError = plain(e); }
  try {
    const [twap] = await r('quote', [U6]);
    d.twap = Number(twap) / 1e6;
  } catch { /* pool history */ }
  return d;
}

async function readMine() {
  if (!S.account) { S.vaults = []; return; }
  try {
    const list = await pub.readContract({ address: C.factory, abi: FACTORY, functionName: 'vaultsOf', args: [S.account] });
    const owned = [];
    for (const v of list) {
      const o = await pub.readContract({ address: v, abi: VAULT, functionName: 'owner' });
      if (o.toLowerCase() === S.account.toLowerCase()) owned.push(v);
    }
    S.vaults = await Promise.all(owned.map(readVault));
  } catch (e) { S.error = 'Could not read your vaults: ' + plain(e); }
}

async function refresh() {
  if (S.refreshing) { S.again = true; return; } // e.g. connect() during the first load: run once more after
  S.refreshing = true; S.loading = true; render();
  try {
    await readMarket(); render();
    await Promise.all([readNetwork().then(render), readMine()]);
  } finally {
    S.refreshing = false; S.loading = false; render();
  }
  if (S.again) { S.again = false; return refresh(); }
  loadLogs(); // in the background; renders again when the buys arrive
}

/* ---------------------------------------------------------------- formatting */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (v, d = 2) => Number(formatUnits(v, 6)).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) });
const okb = (v, d = 6) => Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: d });
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const link = (a, kind = 'address', text) => `<a href="${C.explorer}/${kind}/${a}" target="_blank" rel="noopener">${esc(text || short(a))}</a>`;
const every = (s) => s >= 604800n ? 'every week' : s >= 86400n ? 'every day' : s >= 3600n ? `at most every ${Number(s / 3600n)} h` : s > 0n ? `at most every ${Number(s / 60n)} min` : 'whenever the price is right';
const when = (ts) => { const d = Number(ts) * 1000 - Date.now(); if (d <= 0) return 'now'; const h = Math.floor(d / 3.6e6), m = Math.ceil((d % 3.6e6) / 6e4); return h ? `${h} h ${m} min` : `${m} min`; };
const isDca = (d) => d.minInterval >= 86400n;
function strategyText(d) {
  if (isDca(d)) return { name: 'Auto-DCA', line: `${usd(d.perTxCap)} USDT0 of OKB ${every(d.minInterval)}, never above ${usd(d.maxPrice)}` };
  return { name: 'Buy the dip', line: `${usd(d.perTxCap)} USDT0 of OKB when it is ${usd(d.maxPrice)} or lower, up to ${usd(d.dailyCap)} a day` };
}

/* ---------------------------------------------------------------- the circuit (same netlist as TapeOut circuit #1) */
const GATES = [[2, 2], [3, 9], [10, 10], [11, 4], [12, 12], [13, 5], [14, 14], [15, 6], [16, 16], [17, 7], [18, 18], [19, 8], [20, 20]];
function evalCircuit(bits) {
  const s = [false, true];
  for (let i = 0; i < 7; i++) s.push(((bits >> i) & 1) === 1);
  const gates = GATES.map(([a, b]) => { const o = !(s[a] && s[b]); s.push(o); return o; });
  return { gates, allow: s[s.length - 1] };
}
const CHECKS = [
  ['Paused by you', 0, true],
  ['Sent by your helper bot', 1],
  ['OKB only to your wallet', 2],
  ['Price at or under your limit', 3],
  ['Within your amount per buy', 4],
  ['Within today\u2019s limit', 5],
  ['Enough USDT0 in the vault', 6]
];
const PROC = parseAbi(['function eval(uint256 id, bytes inputs) view returns (bytes)']);
/** Plain reason for a "no" from the chip: the first rule that is not met. */
function whyNo(bits) {
  if (bits & 1) return 'you paused the vault';
  if (!(bits & 2)) return 'this bot is not allowed for the vault';
  if (!(bits & 8)) return 'OKB is above your price, or the price is moving too fast';
  if (!(bits & 16)) return 'the amount is outside your per-buy limit';
  if (!(bits & 32)) return 'today’s buy is done, or it is too soon since the last one';
  if (!(bits & 64)) return 'not enough USDT0 in the vault';
  return 'a rule is not met';
}
/** A normal wait (price or timing), not a problem with the vault. */
const waiting = (bits) => (bits & 0x57) === 0x56;

/* ---------------------------------------------------------------- views */
function header() {
  const conn = S.account
    ? `<button class="btn quiet" data-a="refresh" title="Refresh">${esc(short(S.account))}</button>`
    : `<button class="btn primary" data-a="connect">Connect wallet</button>`;
  return `<header class="hdr"><div class="wrap hdr-in">
    <a class="mark" href="#top" aria-label="Latch home">${LOGO}<span>Latch</span></a>
    <nav class="nav"><a href="#how">How it works</a><a href="#safety">Safety</a><a href="#faq">Questions</a></nav>
    ${conn}</div></header>`;
}
const LOGO = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 3v4M12 3v4M16 3v4M8 17v4M12 17v4M16 17v4M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4" stroke="currentColor" stroke-width="1.6"/><rect x="8.5" y="8.5" width="7" height="7" rx="1" fill="currentColor"/></svg>`;

function chipPanel() {
  const bits = S.chip.bits;
  const { gates, allow } = evalCircuit(bits);
  const rows = CHECKS.map(([label, bit, inverse]) => {
    const on = ((bits >> bit) & 1) === 1;
    const good = inverse ? !on : on;
    const sw = inverse ? (on ? 'Yes' : 'No') : (on ? 'Yes' : 'No');
    return `<li><button class="pin ${good ? 'ok' : 'bad'}" data-a="flip" data-bit="${bit}" aria-pressed="${on}" style="--i:${bit}">
      <span class="pin-label">${esc(label)}</span><span class="pin-val">${sw}</span></button></li>`;
  }).join('');
  const cells = gates.map((g, i) => `<span class="gate ${g ? 'hi' : ''}" style="--i:${i}" title="NAND gate ${i + 1}: ${g ? 1 : 0}"></span>`).join('');
  return `<figure class="chip-panel ${allow ? 'allow' : 'deny'}" aria-label="Interactive model of TapeOut circuit #1">
    <ul class="pins">${rows}</ul>
    <div class="die">
      <div class="die-body">
        <div class="gates">${cells}</div>
        <p class="die-name">TapeOut circuit #${C.circuitId}</p>
        <p class="die-sub">13 NAND gates · input <span class="num">0x${bits.toString(16).padStart(2, '0')}</span></p>
      </div>
    </div>
    <div class="verdict">
      <p class="verdict-word">${allow ? 'Buy allowed' : 'Blocked'}</p>
      <p class="verdict-sub">${allow ? 'Uniswap swap runs, OKB lands in your wallet.' : 'Nothing moves. Your USDT0 stays in the vault.'}</p>
      <button class="btn quiet sm" data-a="askChip">${S.chip.live === 'asking' ? 'Asking…' : S.chip.live ? `Chain says: ${S.chip.live}` : 'Ask the real chip'}</button>
    </div>
    <figcaption>Every buy is checked by this circuit on chain. Tap any rule to flip it and see what the chip decides.</figcaption>
  </figure>`;
}

function hero() {
  const n = S.net;
  return `<section class="hero wrap" id="top">
    <div class="hero-copy">
      <h1>Stack OKB on autopilot, without trusting a bot.</h1>
      <p class="lead">Put USDT0 in a vault only you control. Latch buys OKB on the dip or on a schedule and sends it to your wallet as WOKB (wrapped OKB, always worth 1 OKB). Your vault checks every buy against your rules, and a TapeOut chip on the blockchain must agree, so the bot can never buy too much, pay too much, or send your money anywhere else.</p>
      <div class="cta-row">
        <button class="btn primary lg" data-a="wizard">Create my vault</button>
        <a class="btn quiet lg" href="#safety">See how it stays safe</a>
      </div>
      <dl class="facts">
        <div><dt>OKB price</dt><dd class="num">${S.price ? S.price.toFixed(2) : '…'}</dd></div>
        <div><dt>OKB bought</dt><dd class="num">${n ? okb(n.okb, 4) : '…'}</dd></div>
        <div><dt>Buys checked</dt><dd class="num">${n ? n.buys : '…'}</dd></div>
        <div><dt>Vaults</dt><dd class="num">${S.vaultCount ?? '…'}</dd></div>
      </dl>
    </div>
    ${chipPanel()}
  </section>`;
}

function stepsBar(step) {
  const steps = ['Strategy', 'Settings', 'Review', 'Add funds'];
  return `<ol class="steps">${steps.map((s, i) => `<li class="${i === step ? 'on' : i < step ? 'done' : ''}">${s}</li>`).join('')}</ol>`;
}
const ICON_DIP = `<svg viewBox="0 0 48 24" width="48" height="24" aria-hidden="true"><path d="M2 6 L14 9 L22 20 L30 12 L46 4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="22" cy="20" r="3" fill="currentColor"/></svg>`;
const ICON_DCA = `<svg viewBox="0 0 48 24" width="48" height="24" aria-hidden="true"><path d="M2 20 H46" stroke="currentColor" stroke-width="1.5" opacity=".5"/>${[6, 16, 26, 36, 46].map((x) => `<rect x="${x - 3}" y="8" width="6" height="12" rx="1" fill="currentColor"/>`).join('')}</svg>`;

function wizardView() {
  const w = S.wizard; if (!w) return '';
  const p = S.price || 0;
  let body = '';
  if (w.step === 0) {
    body = `<div class="choices">
      <button class="choice ${w.strategy === 'dip' ? 'sel' : ''}" data-a="strategy" data-v="dip">${ICON_DIP}
        <b>Buy the dip</b><span>Buys only when OKB falls to the price you pick.</span></button>
      <button class="choice ${w.strategy === 'dca' ? 'sel' : ''}" data-a="strategy" data-v="dca">${ICON_DCA}
        <b>Auto-DCA</b><span>Buys a fixed amount every day or week, up to a price ceiling.</span></button>
    </div>
    <div class="row end"><button class="btn primary" data-a="next" ${w.strategy ? '' : 'disabled'}>Continue</button></div>`;
  } else if (w.step === 1) {
    const dip = w.strategy === 'dip';
    body = `<div class="form">
      <label>Amount per buy (USDT0)<input id="f-perBuy" type="number" min="1" step="0.5" inputmode="decimal" value="${esc(w.perBuy)}"><small>At least 1 USDT0.</small></label>
      ${dip
        ? `<label>Buy when OKB is at or below<input id="f-price" type="number" step="0.1" inputmode="decimal" value="${esc(w.price)}"><small>OKB is ${p.toFixed(2)} now. Latch uses the 30-minute average, so a one-second wick doesn't count.</small></label>
           <label>Most buys per day<input id="f-perDay" type="number" min="1" max="24" step="1" inputmode="numeric" value="${esc(w.perDay)}"></label>`
        : `<label>How often<select id="f-every"><option value="86400" ${w.every === '86400' ? 'selected' : ''}>Every day</option><option value="604800" ${w.every === '604800' ? 'selected' : ''}>Every week</option></select></label>
           <label>Never pay more than (USDT0 per OKB)<input id="f-price" type="number" step="1" inputmode="decimal" value="${esc(w.price)}"><small>OKB is ${p.toFixed(2)} now. The ceiling stops buys during a spike.</small></label>`}
      <label>Send the OKB to<input id="f-savings" type="text" spellcheck="false" value="${esc(w.savings)}"><small>Fixed forever once the vault is created.</small></label>
      <details ${w.ownBot ? 'open' : ''}><summary>Use my own bot or AI agent</summary>
        <label class="chk"><input id="f-ownBot" type="checkbox" ${w.ownBot ? 'checked' : ''}> Use my own bot instead of Latch's</label>
        <label>Bot address<input id="f-botAddr" type="text" spellcheck="false" placeholder="0x…" value="${esc(w.botAddr)}"><small>It gets the same limits and can never withdraw or change settings.</small></label>
      </details>
    </div>
    <div class="row between"><button class="btn quiet" data-a="back">Back</button><button class="btn primary" data-a="next">Review</button></div>`;
  } else if (w.step === 2) {
    const per = Number(w.perBuy); const dip = w.strategy === 'dip';
    const daily = dip ? per * Number(w.perDay) : per;
    body = `<p class="summary">${dip
      ? `When OKB's 30-minute average is <b>${esc(w.price)}</b> or lower, Latch buys <b>${per} USDT0</b> of OKB, up to <b>${daily} USDT0</b> a day.`
      : `Latch buys <b>${per} USDT0</b> of OKB <b>${w.every === '604800' ? 'every week' : 'every day'}</b>, never above <b>${esc(w.price)}</b> per OKB.`}</p>
      <ul class="terms">
        <li>OKB goes to <span class="num">${esc(short(w.savings))}</span>.</li>
        <li>Swaps use Uniswap's deepest USDT0/OKB pool and are refused if more than 1% worse than the average price.</li>
        <li>${w.ownBot ? 'Your bot' : 'Latch’s bot'} can only trigger buys. It can't withdraw, raise limits or redirect OKB.</li>
        <li>TapeOut circuit #${C.circuitId} must approve every buy on chain.</li>
        <li>Pause or withdraw any time. Fee: 1% per buy on top of your price, no other Latch fees.</li>
        <li>You receive WOKB (wrapped OKB, worth 1 OKB each).</li>
      </ul>
    <div class="row between"><button class="btn quiet" data-a="back">Back</button><button class="btn primary" data-a="create" ${S.busy ? 'disabled' : ''}>${S.busy ? esc(S.busy) + '…' : 'Create my vault'}</button></div>`;
  } else {
    body = `<p class="summary">Your vault is live at ${link(w.created)}. Add USDT0 for it to spend.</p>
    <div class="form"><label>Amount to add (USDT0)<input id="f-deposit" type="number" min="0" step="0.5" inputmode="decimal" value="${esc(w.deposit)}"><small>Your wallet holds ${S.usdtWallet != null ? usd(S.usdtWallet) : '…'} USDT0.</small></label></div>
    <div class="row between"><button class="btn quiet" data-a="closeWizard">Later</button><button class="btn primary" data-a="deposit" ${S.busy ? 'disabled' : ''}>${S.busy ? esc(S.busy) + '…' : 'Add USDT0'}</button></div>`;
  }
  return `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="wz-t"><div class="sheet">
    <div class="row between"><h2 id="wz-t">Create your vault</h2><button class="x" data-a="closeWizard" aria-label="Close">×</button></div>
    ${stepsBar(w.step)}${S.error ? `<p class="err" role="alert">${esc(S.error)}</p>` : ''}${body}</div></div>`;
}

function dialogView() {
  const g = S.dialog; if (!g) return '';
  return `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="dg-t"><form class="sheet small" data-form="dialog">
    <div class="row between"><h2 id="dg-t">${esc(g.title)}</h2><button type="button" class="x" data-a="closeDialog" aria-label="Close">×</button></div>
    ${g.text ? `<p class="dlg-text">${g.text}</p>` : ''}
    ${g.field ? `<label class="form">${esc(g.field)}<input id="dg-v" type="number" step="any" inputmode="decimal" value="${esc(g.value)}" autofocus>${g.hint ? `<small>${esc(g.hint)}</small>` : ''}</label>` : ''}
    ${S.error ? `<p class="err" role="alert">${esc(S.error)}</p>` : ''}
    <div class="row end gap"><button type="button" class="btn quiet" data-a="closeDialog">Cancel</button><button type="submit" class="btn ${g.danger ? 'danger' : 'primary'}" ${S.busy ? 'disabled' : ''}>${S.busy ? esc(S.busy) + '…' : esc(g.ok)}</button></div>
  </form></div>`;
}

function vaultCard(d) {
  const st = strategyText(d);
  const avg = d.bought > 0n ? Number(d.spent) / 1e6 / (Number(d.bought) / 1e18) : null;
  const usedPct = d.dailyCap > 0n ? Math.min(100, Number((d.spentToday * 100n) / d.dailyCap)) : 0;
  const status = d.paused ? ['Paused', 'paused'] : d.allow ? ['Buying', 'live'] : ['Waiting', 'wait'];
  const nextLine = d.paused ? 'Paused. Nothing will be bought until you resume.'
    : d.balance < 1_000_000n ? 'Add USDT0 so Latch has something to buy with.'
    : d.allow ? 'All checks pass. The bot buys within about a minute.'
    : ((d.bits >> 3) & 1) === 0 ? `Waiting for OKB to reach ${usd(d.maxPrice)} (30-min average now ${d.twap ? d.twap.toFixed(2) : '…'}).`
    : ((d.bits >> 5) & 1) === 0 ? (d.nextBuyAt > 0n ? `Next buy in ${when(d.nextBuyAt)}.` : 'Today’s limit is used. Next buy after midnight UTC.')
    : 'Waiting for the next check.';
  const checks = d.bits == null ? `<p class="muted">${esc(d.previewError || 'Checks unavailable right now.')}</p>`
    : `<ul class="checks">${CHECKS.map(([label, bit, inverse]) => {
      const on = (d.bits >> bit) & 1; const pass = inverse ? !on : !!on;
      return `<li class="${pass ? 'ok' : 'bad'}">${esc(inverse ? 'Not paused by you' : label)}</li>`;
    }).join('')}</ul>
    <p class="chip-line ${d.chip ? 'ok' : waiting(d.bits) ? 'wait' : 'bad'}">TapeOut circuit #${C.circuitId} says <b>${d.chip ? 'yes' : 'no'}</b> to input <span class="num">0x${d.bits.toString(16).padStart(2, '0')}</span>${d.chip ? '' : ` (${esc(whyNo(d.bits))})`}. ${link(C.processor, 'address', 'View the chip')}</p>`;
  const h = S.hist[d.address];
  const hist = h === undefined ? '<p class="muted">Loading recent buys…</p>'
    : h === null ? '<p class="muted">Recent buys could not be loaded.</p>'
    : h.length ? `<table class="hist"><thead><tr><th>Paid</th><th>Received</th><th>Chip</th><th>Transaction</th></tr></thead><tbody>${h.map((x) => `<tr><td class="num">${usd(x.inn)} USDT0</td><td class="num">${okb(x.out)} WOKB</td><td class="num ok">yes</td><td>${link(x.hash, 'tx')}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No buys yet.</p>';
  const busy = S.busy ? 'disabled' : '';
  return `<article class="vault" data-v="${d.address}">
    <header class="vault-head">
      <span class="vault-icon">${isDca(d) ? ICON_DCA : ICON_DIP}</span>
      <div><h3>${esc(st.name)}</h3><p class="muted">${esc(st.line)}</p></div>
      <span class="status ${status[1]}">${status[0]}</span>
    </header>
    <dl class="vault-stats">
      <div><dt>OKB bought</dt><dd class="num">${okb(d.bought)}</dd></div>
      <div><dt>Average price (before fee)</dt><dd class="num">${avg ? avg.toFixed(2) : '—'}</dd></div>
      <div><dt>USDT0 left</dt><dd class="num">${usd(d.balance)}</dd></div>
      <div><dt>Buys</dt><dd class="num">${d.buys}</dd></div>
    </dl>
    <div class="meter" role="img" aria-label="${usedPct}% of today's limit used"><span style="width:${usedPct}%"></span></div>
    <p class="meter-label"><span>${usd(d.spentToday)} of ${usd(d.dailyCap)} USDT0 used today</span><span>${esc(nextLine)}</span></p>
    <details data-k="${d.address}:checks" ${S.open[d.address + ':checks'] ? 'open' : ''}><summary>Checks for the next buy</summary>${checks}</details>
    <details data-k="${d.address}:buys" ${S.open[d.address + ':buys'] ? 'open' : ''}><summary>Recent buys</summary>${hist}</details>
    <div class="actions">
      <button class="btn primary sm" data-a="addFunds" ${busy}>Add USDT0</button>
      <button class="btn quiet sm" data-a="${d.paused ? 'resume' : 'pause'}" ${busy}>${d.paused ? 'Resume' : 'Pause'}</button>
      <button class="btn quiet sm" data-a="setPrice" ${busy}>Change price</button>
      <button class="btn quiet sm" data-a="setEvery" ${busy}>Change spacing</button>
      <button class="btn quiet sm" data-a="withdraw" ${busy}>Withdraw all</button>
    </div>
    <p class="fine">Vault ${link(d.address)}. WOKB (wrapped OKB) goes to ${link(d.savings)}. Bot: ${d.keeper.toLowerCase() === (S.hostedKeeper || '').toLowerCase() ? 'Latch hosted' : link(d.keeper)}. Fee ${(Number(d.bps) / 100).toFixed(2)}%.</p>
  </article>`;
}

function dashboard() {
  if (!S.account) return '';
  const list = S.vaults.length ? S.vaults.map(vaultCard).join('')
    : `<div class="empty"><p>No vault yet. It takes one transaction to create one.</p><button class="btn primary" data-a="wizard">Create my vault</button></div>`;
  return `<section class="wrap block" id="vaults"><div class="row between"><h2>Your vaults</h2><button class="btn quiet sm" data-a="refresh">${S.loading ? 'Loading…' : 'Refresh'}</button></div>
    ${S.error && !S.wizard && !S.dialog ? `<p class="err" role="alert">${esc(S.error)}</p>` : ''}${list}
    ${S.txs.length ? `<p class="fine">Last action: ${esc(S.txs[0].label)}, ${esc(S.txs[0].state)}. ${link(S.txs[0].hash, 'tx')}</p>` : ''}</section>`;
}

function feedView() {
  if (!S.feed || !S.feed.length) return '';
  return `<section class="wrap block"><h2>Latest buys on X Layer</h2>
    <ul class="feed">${S.feed.map((f) => `<li><span class="num">${okb(f.out)} WOKB</span><span class="muted">for ${usd(f.inn)} USDT0</span><span class="ok">chip said yes</span>${link(f.hash, 'tx', 'transaction')}</li>`).join('')}</ul></section>`;
}

function info() {
  return `<section class="wrap block" id="how"><h2>How a buy happens</h2>
    <ol class="flow">
      <li><b>The bot asks</b><span>Every minute, Latch's bot asks your vault to buy.</span></li>
      <li><b>Your vault checks 7 rules</b><span>Your price, your limits, your wallet, not paused, enough funds.</span></li>
      <li><b>The TapeOut chip decides</b><span>Circuit #${C.circuitId} on X Layer must say yes, or the buy stops.</span></li>
      <li><b>Uniswap swaps</b><span>USDT0 becomes OKB at the fair price, or the swap is refused.</span></li>
      <li><b>OKB lands in your wallet</b><span>As WOKB (wrapped OKB). Never in the vault, never anywhere else.</span></li>
    </ol>
  </section>
  <section class="wrap block split" id="safety">
    <div><h2>What a stolen bot key could do</h2>
      <p>Most trading bots hold your keys. If they are hacked, your account is emptied. With Latch, the worst a stolen bot key can do is buy your chosen amount of OKB, at your price or better, into your own wallet. Latch can also switch any bot key off for every vault at once (this can only stop buys, never move funds).</p>
      <p>The vault also refuses a buy if Uniswap's price jumped away from its 30-minute average, and the bot refuses if Uniswap disagrees with the major exchanges.</p></div>
    <div><h2>What only you can do</h2>
      <ul class="plain"><li>Withdraw everything, any time, even while paused</li><li>Pause and resume buying</li><li>Change your price and spacing</li><li>Lower your limits or switch to your own bot or AI agent, directly on your vault contract (limits can never be raised)</li></ul></div>
  </section>
  <section class="wrap block split">
    <div><h2>Fees</h2><p>1% of each buy, falling to 0.75%, 0.5% and 0.25% as your vault's volume grows. The fee comes on top of the price you set. Uniswap's pool also keeps its 0.05% trading fee. No sign-up or withdrawal fees. Latch's bot pays the gas.</p></div>
    <div><h2>Checked and open</h2><p>Open-source contracts, Slither with zero findings, two independent reviews by separate AI agents (not a professional audit), and tests against Uniswap's real code. ${`<a href="${C.repo}" target="_blank" rel="noopener">Read the code and the reviews</a>`}.</p></div>
  </section>
  <section class="wrap block faq" id="faq"><h2>Questions</h2>
    <details><summary>Can Latch take my money?</summary><p>No. Only the wallet that created the vault can withdraw. Latch's bot can only trigger buys within your rules, into your wallet.</p></details>
    <details><summary>What if OKB never reaches my price?</summary><p>Nothing is bought and your USDT0 stays in the vault. Change the price or withdraw whenever you like.</p></details>
    <details><summary>Which wallet do I need?</summary><p>OKX Wallet: the browser extension on a computer, or open this page from the Discover tab in the OKX Wallet app.</p></details>
    <details><summary>Why do I receive WOKB, not OKB?</summary><p>Uniswap trades the wrapped form of OKB. Each WOKB is worth exactly 1 OKB. Add the WOKB token in OKX Wallet to see it, and swap it back to OKB whenever you like.</p></details>
    <details><summary>What are the risks?</summary><p>OKB's price can fall after you buy. USDT0's issuer can freeze addresses. Smart contracts can have bugs; Latch's are reviewed and tested, but start small.</p></details>
  </section>`;
}

function render() {
  const app = document.getElementById('app');
  const focus = document.activeElement?.id;
  app.innerHTML = header() + `<main>${hero()}${S.note ? `<p class="wrap note" role="status">${esc(S.note)}</p>` : ''}${dashboard()}${feedView()}${info()}</main>
    <footer class="wrap foot"><span>Latch runs on X Layer and checks every buy with TapeOut circuit #${C.circuitId}.</span><span>${link(C.factory, 'address', 'Factory contract')} · <a href="${C.repo}" target="_blank" rel="noopener">GitHub</a></span></footer>` + wizardView() + dialogView();
  if (focus) document.getElementById(focus)?.focus();
  if (S.dialog && !focus) document.getElementById('dg-v')?.focus();
}

/* ---------------------------------------------------------------- actions */
function readWizardForm() {
  const w = S.wizard; const g = (id) => document.getElementById(id);
  for (const k of ['perBuy', 'price', 'perDay', 'every', 'savings', 'botAddr', 'deposit']) if (g('f-' + k)) w[k] = g('f-' + k).value.trim();
  if (g('f-ownBot')) w.ownBot = g('f-ownBot').checked;
}
function validate(w) {
  if (!(Number(w.perBuy) >= 1)) return 'Amount per buy must be at least 1 USDT0.';
  if (!(Number(w.price) > 0)) return 'Enter a price above 0.';
  if (w.strategy === 'dip' && !(Number(w.perDay) >= 1)) return 'Most buys per day must be at least 1.';
  if (!isAddress(w.savings)) return 'The "Send the OKB to" address is not valid.';
  if (w.ownBot && !isAddress(w.botAddr)) return 'Your bot address is not valid.';
  return '';
}
function openDialog(d) { S.error = ''; S.dialog = d; render(); }

async function runDialog() {
  const g = S.dialog; if (!g) return;
  const raw = document.getElementById('dg-v')?.value?.trim();
  let r = null;
  try {
    if (g.kind === 'add') r = await send('Adding USDT0', { address: C.usdt, abi: ERC20, functionName: 'transfer', args: [g.vault, parseUnits(raw || '0', 6)] });
    if (g.kind === 'price') r = await send('Changing price', { address: g.vault, abi: VAULT, functionName: 'setMaxPrice', args: [parseUnits(raw || '0', 6)] });
    if (g.kind === 'every') r = await send('Changing spacing', { address: g.vault, abi: VAULT, functionName: 'setMinInterval', args: [BigInt(Math.round(Number(raw || 0) * 3600))] });
    if (g.kind === 'withdraw') r = await send('Withdrawing', { address: g.vault, abi: VAULT, functionName: 'withdraw', args: [C.usdt, S.account, MAX] });
  } catch (e) { S.error = plain(e); render(); return; }
  if (r) { S.dialog = null; await refresh(); }
}

async function act(a, el) {
  const card = el.closest('[data-v]'); const v = card?.dataset.v;
  const d = S.vaults.find((x) => x.address === v);
  S.error = '';
  switch (a) {
    case 'connect': return connect();
    case 'refresh': return refresh();
    case 'flip': S.chip.bits ^= 1 << Number(el.dataset.bit); S.chip.live = false; return render();
    case 'askChip': {
      S.chip.live = 'asking'; render();
      try {
        const out = await pub.readContract({ address: C.processor, abi: PROC, functionName: 'eval', args: [BigInt(C.circuitId), '0x' + S.chip.bits.toString(16).padStart(2, '0')] });
        S.chip.live = (parseInt(out.slice(2, 4), 16) & 1) ? 'yes' : 'no';
      } catch { S.chip.live = 'nothing (no connection)'; }
      return render();
    }
    case 'wizard': {
      if (!S.account) { await connect(); if (!S.account) return; }
      const p = S.price || 80;
      S.wizard = { step: 0, strategy: '', perBuy: '5', price: (Math.floor(p * 0.9 * 10) / 10).toString(), perDay: '2', every: '604800', savings: S.account, ownBot: false, botAddr: '', deposit: '20' };
      return render();
    }
    case 'closeWizard': S.wizard = null; return refresh();
    case 'closeDialog': S.dialog = null; return render();
    case 'strategy': S.wizard.strategy = el.dataset.v; S.wizard.price = el.dataset.v === 'dca' ? String(Math.ceil((S.price || 80) * 1.5)) : (Math.floor((S.price || 80) * 0.9 * 10) / 10).toString(); return render();
    case 'back': readWizardForm(); S.wizard.step--; return render();
    case 'next': {
      if (S.wizard.step === 1) { readWizardForm(); const e = validate(S.wizard); if (e) { S.error = e; return render(); } }
      S.wizard.step++; return render();
    }
    case 'create': {
      const w = S.wizard; const dip = w.strategy === 'dip';
      const per = parseUnits(w.perBuy, 6);
      const daily = dip ? per * BigInt(Math.floor(Number(w.perDay))) : per;
      const interval = dip ? 0n : BigInt(w.every);
      const r = await send('Creating your vault', {
        address: C.factory, abi: FACTORY, functionName: 'createVault',
        args: [getAddress(w.savings), per, daily, parseUnits(w.price, 6), interval, w.ownBot ? getAddress(w.botAddr) : '0x0000000000000000000000000000000000000000']
      });
      if (!r) return;
      const list = await pub.readContract({ address: C.factory, abi: FACTORY, functionName: 'vaultsOf', args: [S.account] });
      w.created = list[list.length - 1];
      S.usdtWallet = await pub.readContract({ address: C.usdt, abi: ERC20, functionName: 'balanceOf', args: [S.account] }).catch(() => null);
      w.step = 3; return render();
    }
    case 'deposit': {
      readWizardForm();
      const amt = parseUnits(S.wizard.deposit || '0', 6);
      if (amt <= 0n) { S.error = 'Enter an amount above 0.'; return render(); }
      const r = await send('Adding USDT0', { address: C.usdt, abi: ERC20, functionName: 'transfer', args: [S.wizard.created, amt] });
      if (r) { S.wizard = null; await refresh(); }
      return;
    }
    case 'addFunds': {
      const bal = await pub.readContract({ address: C.usdt, abi: ERC20, functionName: 'balanceOf', args: [S.account] }).catch(() => null);
      return openDialog({ kind: 'add', vault: v, title: 'Add USDT0', field: 'Amount (USDT0)', value: '5', hint: bal != null ? `Your wallet holds ${usd(bal)} USDT0.` : '', ok: 'Add USDT0' });
    }
    case 'pause': case 'resume': {
      const r = await send(a === 'pause' ? 'Pausing' : 'Resuming', { address: v, abi: VAULT, functionName: 'setPaused', args: [a === 'pause'] });
      if (r) await refresh(); return;
    }
    case 'setPrice':
      return openDialog({ kind: 'price', vault: v, title: isDca(d) ? 'Change price ceiling' : 'Change buy price', field: isDca(d) ? 'Never pay more than (USDT0 per OKB)' : 'Buy when OKB is at or below', value: usd(d.maxPrice).replace(/,/g, ''), hint: `OKB is ${S.price ? S.price.toFixed(2) : '…'} now.`, ok: 'Save price' });
    case 'setEvery':
      return openDialog({ kind: 'every', vault: v, title: 'Change spacing', field: 'Hours between buys', value: String(Number(d.minInterval) / 3600), hint: '0 = no spacing, 24 = daily, 168 = weekly.', ok: 'Save spacing' });
    case 'withdraw':
      return openDialog({ kind: 'withdraw', vault: v, title: 'Withdraw all USDT0', text: `${usd(d.balance)} USDT0 goes back to your wallet ${esc(short(S.account))}. Pause first if you also want buying to stop.`, ok: 'Withdraw all', danger: true });
  }
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]'); if (!el || el.disabled) return;
  e.preventDefault(); act(el.dataset.a, el);
});
document.addEventListener('submit', (e) => {
  if (e.target.matches('[data-form=dialog]')) { e.preventDefault(); runDialog(); }
});
// Remember which sections are open, so re-rendering (refresh every minute, buys arriving) keeps them open.
document.addEventListener('toggle', (e) => {
  const k = e.target?.dataset?.k; if (k) S.open[k] = e.target.open;
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (S.dialog || S.wizard) && !S.busy) { S.dialog = null; if (S.wizard) { S.wizard = null; refresh(); } else render(); }
});

render();
refresh();
setInterval(() => { if (!S.busy && !S.wizard && !S.dialog) refresh(); }, 60_000);
window.__latch = S; // for tests and debugging
