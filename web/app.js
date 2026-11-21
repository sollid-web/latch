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
  'error PriceTooHigh(uint256,uint256)', 'error PriceUnstable()', 'error CircuitDenied(uint8)', 'error NotArmed()'
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
  OverCap: 'Per-buy amount must be above 0 and not more than the daily limit.'
};

/* ---------------------------------------------------------------- state */
const S = {
  account: null, walletChain: null, provider: null, walletName: '',
  price: null, vaultCount: null, hostedKeeper: null, circuitOk: null,
  vaults: [], loading: false, error: '', note: '',
  wizard: null, // {step, strategy, perBuy, price, perDay, every, savings, ownBot, botAddr, created, deposit}
  busy: '', txs: []
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

async function readVault(v) {
  const r = (fn, args = [], account) => pub.readContract({ address: v, abi: VAULT, functionName: fn, args, account });
  const [st, maxPrice, minInterval, nextBuyAt, spent, bought, buys, bps, usdtBal] = await Promise.all([
    r('status'), r('maxPrice'), r('minInterval'), r('nextBuyAt'), r('volumeSwept'), r('totalBought'), r('buys'), r('feeBpsNow'),
    pub.readContract({ address: C.usdt, abi: ERC20, functionName: 'balanceOf', args: [v] })
  ]);
  const d = {
    address: v, paused: st[2], armed: st[1], balance: st[3], perTxCap: st[4], dailyCap: st[5], spentToday: st[6],
    keeper: st[7], savings: st[8], maxPrice, minInterval, nextBuyAt, spent, bought, buys, bps, usdtBal
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
  d.history = await recentBuys(v).catch(() => null);
  return d;
}

async function recentBuys(v) {
  const latest = await pub.getBlockNumber();
  const out = [];
  const STEP = 900n;
  for (let i = 0; i < 6 && out.length < 8; i++) {
    const to = latest - STEP * BigInt(i);
    const from = to > STEP ? to - STEP + 1n : 0n;
    const logs = await pub.getLogs({ address: v, event: BOUGHT, fromBlock: from, toBlock: to });
    for (const l of logs.reverse()) out.push({ hash: l.transactionHash, inn: l.args.amountIn, out: l.args.amountOut, fee: l.args.fee, bits: Number(l.args.bits), block: l.blockNumber });
    if (from === 0n) break;
  }
  return out;
}

async function refresh() {
  S.loading = true; render();
  await readMarket();
  if (S.account) {
    try {
      const list = await pub.readContract({ address: C.factory, abi: FACTORY, functionName: 'vaultsOf', args: [S.account] });
      const owned = [];
      for (const v of list) {
        const o = await pub.readContract({ address: v, abi: VAULT, functionName: 'owner' });
        if (o.toLowerCase() === S.account.toLowerCase()) owned.push(v);
      }
      S.vaults = await Promise.all(owned.map(readVault));
    } catch (e) { S.error = 'Could not read your vaults: ' + plain(e); }
  } else S.vaults = [];
  S.loading = false; render();
}

/* ---------------------------------------------------------------- formatting */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (v, d = 2) => Number(formatUnits(v, 6)).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d > 2 ? 2 : d });
const okb = (v) => Number(formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const link = (a, kind = 'address') => `<a href="${C.explorer}/${kind}/${a}" target="_blank" rel="noopener">${esc(short(a))}</a>`;
const every = (s) => s >= 604800n ? 'every week' : s >= 86400n ? 'every day' : s >= 3600n ? `at most every ${Number(s / 3600n)} h` : s > 0n ? `at most every ${Number(s / 60n)} min` : 'whenever the price is right';
const when = (ts) => { const d = Number(ts) * 1000 - Date.now(); if (d <= 0) return 'now'; const h = Math.floor(d / 3.6e6), m = Math.ceil((d % 3.6e6) / 6e4); return h ? `in ${h} h ${m} min` : `in ${m} min`; };
function strategyText(d) {
  const amt = usd(d.perTxCap);
  if (d.minInterval >= 86400n) return `Auto-DCA: buys ${amt} USDT0 of OKB ${every(d.minInterval)}, never above ${usd(d.maxPrice)} per OKB.`;
  return `Buy the dip: buys ${amt} USDT0 of OKB when OKB is at or below ${usd(d.maxPrice)}, up to ${usd(d.dailyCap)} a day${d.minInterval > 0n ? ', ' + every(d.minInterval) : ''}.`;
}
const CHECKS = [
  ['Not paused by you', 0, true],
  ['Request comes from your helper bot', 1],
  ['OKB goes only to your wallet', 2],
  ['OKB price is at or below your limit, and steady', 3],
  ['Within your amount per buy', 4],
  ['Within today’s limit and buy spacing', 5],
  ['Enough USDT0 in the vault', 6]
];

/* ---------------------------------------------------------------- views */
function header() {
  const conn = S.account
    ? `<button class="btn sm" data-a="refresh" title="Refresh">${esc(short(S.account))}</button>`
    : `<button class="btn sm amber" data-a="connect">Connect wallet</button>`;
  return `<header class="hdr"><div class="hdr-in">
    <a class="wordmark" href="#top">LATCH</a>
    <span class="net">X Layer</span>
    <span class="grow"></span>${conn}</div></header>`;
}

function hero() {
  const price = S.price ? S.price.toFixed(2) : '…';
  return `<section class="hero" id="top">
    <p class="eyebrow">Automatic OKB buying on X Layer</p>
    <h1>Stack OKB on autopilot.<br><span class="hl">Without trusting a bot.</span></h1>
    <p class="lead">Put USDT0 in a vault only you control. Latch buys OKB for you on the dip or every week, and sends it straight to your wallet. The blockchain itself stops the bot from ever buying too much, paying too much, or sending your money anywhere else.</p>
    <div class="row gap">
      <button class="btn amber lg" data-a="wizard">Create my vault</button>
      <a class="btn lg ghost" href="#safety">How it keeps you safe</a>
    </div>
    <div class="strip">
      <div><span class="k">OKB price (Uniswap)</span><span class="v mono">${price}</span></div>
      <div><span class="k">Vaults created</span><span class="v mono">${S.vaultCount ?? '…'}</span></div>
      <div><span class="k">Safety rule chip</span><span class="v mono"><a href="${C.explorer}/address/${C.processor}" target="_blank" rel="noopener">TapeOut circuit #${C.circuitId}</a></span></div>
    </div>
  </section>`;
}

function wizardView() {
  const w = S.wizard; if (!w) return '';
  const p = S.price || 0;
  const steps = ['Strategy', 'Settings', 'Review', 'Add funds'];
  const bar = `<ol class="steps">${steps.map((s, i) => `<li class="${i === w.step ? 'on' : i < w.step ? 'done' : ''}">${i + 1}. ${s}</li>`).join('')}</ol>`;
  let body = '';
  if (w.step === 0) {
    body = `<div class="choices">
      <button class="choice ${w.strategy === 'dip' ? 'sel' : ''}" data-a="strategy" data-v="dip">
        <b>Buy the dip</b><span>Buy only when OKB falls to a price you choose. Good if you think it will dip.</span></button>
      <button class="choice ${w.strategy === 'dca' ? 'sel' : ''}" data-a="strategy" data-v="dca">
        <b>Auto-DCA</b><span>Buy a fixed amount every day or week, whatever the price (up to a ceiling). The classic way to build a position slowly.</span></button>
    </div>
    <div class="row end"><button class="btn amber" data-a="next" ${w.strategy ? '' : 'disabled'}>Next</button></div>`;
  } else if (w.step === 1) {
    const dip = w.strategy === 'dip';
    body = `<div class="form">
      <label>Amount per buy (USDT0)<input id="f-perBuy" type="number" min="0.1" step="0.1" value="${esc(w.perBuy)}"></label>
      ${dip
        ? `<label>Buy when OKB is at or below (USDT0)<input id="f-price" type="number" step="0.1" value="${esc(w.price)}"><small>Now about ${p.toFixed(2)}. Latch uses the 30-minute average, so a one-second flash does not count.</small></label>
           <label>Most buys per day<input id="f-perDay" type="number" min="1" max="24" step="1" value="${esc(w.perDay)}"></label>`
        : `<label>How often<select id="f-every"><option value="86400" ${w.every === '86400' ? 'selected' : ''}>Every day</option><option value="604800" ${w.every === '604800' ? 'selected' : ''}>Every week</option></select></label>
           <label>Never pay more than (USDT0 per OKB)<input id="f-price" type="number" step="1" value="${esc(w.price)}"><small>Now about ${p.toFixed(2)}. A ceiling protects you from buying during a spike.</small></label>`}
      <label>Send the OKB to<input id="f-savings" type="text" value="${esc(w.savings)}"><small>Your connected wallet by default. This can never be changed later.</small></label>
      <details ${w.ownBot ? 'open' : ''}><summary>Advanced: use my own bot or AI agent</summary>
        <label class="chk"><input id="f-ownBot" type="checkbox" ${w.ownBot ? 'checked' : ''}> Use my own bot instead of Latch's hosted bot</label>
        <label>Bot address<input id="f-botAddr" type="text" placeholder="0x…" value="${esc(w.botAddr)}"><small>Your bot gets exactly the same limits. It can never withdraw or change your settings.</small></label>
      </details>
    </div>
    <div class="row between"><button class="btn ghost" data-a="back">Back</button><button class="btn amber" data-a="next">Review</button></div>`;
  } else if (w.step === 2) {
    const per = Number(w.perBuy);
    const dip = w.strategy === 'dip';
    const daily = dip ? per * Number(w.perDay) : per;
    body = `<div class="review">
      <p class="big">${dip
        ? `When OKB's 30-minute average is <b>${esc(w.price)} USDT0 or lower</b>, Latch buys <b>${per} USDT0</b> of OKB, up to <b>${daily} USDT0 a day</b>.`
        : `Latch buys <b>${per} USDT0</b> of OKB <b>${w.every === '604800' ? 'every week' : 'every day'}</b>, but never above <b>${esc(w.price)} USDT0</b> per OKB.`}</p>
      <ul class="facts">
        <li>OKB goes straight to <span class="mono">${esc(short(w.savings))}</span>. Nobody can change that.</li>
        <li>Swaps happen on Uniswap's deepest USDT0/OKB pool. A swap more than 1% worse than the average price is refused.</li>
        <li>${w.ownBot ? 'Your own bot' : 'Latch’s hosted bot'} sends the buys. It can't withdraw, can't raise your limits and can't send OKB anywhere else.</li>
        <li>Every buy also has to pass TapeOut safety circuit #${C.circuitId} on chain.</li>
        <li>You can pause or withdraw everything at any time.</li>
        <li>Fee: 1% of each buy (falls to 0.25% as you use it). No sign-up fee.</li>
      </ul>
    </div>
    <div class="row between"><button class="btn ghost" data-a="back">Back</button><button class="btn amber" data-a="create" ${S.busy ? 'disabled' : ''}>${S.busy ? esc(S.busy) + '…' : 'Create my vault'}</button></div>`;
  } else {
    body = `<p class="big">Vault created: ${link(w.created)}. Now add USDT0 for it to spend.</p>
    <div class="form"><label>Amount to add (USDT0)<input id="f-deposit" type="number" min="0" step="0.1" value="${esc(w.deposit)}"><small>Your wallet has ${S.usdtWallet != null ? usd(S.usdtWallet) : '…'} USDT0.</small></label></div>
    <div class="row between"><button class="btn ghost" data-a="closeWizard">Later</button><button class="btn amber" data-a="deposit" ${S.busy ? 'disabled' : ''}>${S.busy ? esc(S.busy) + '…' : 'Add funds'}</button></div>`;
  }
  return `<div class="modal" role="dialog" aria-modal="true"><div class="sheet">
    <div class="row between"><h2>Create your vault</h2><button class="x" data-a="closeWizard" aria-label="Close">×</button></div>
    ${bar}${S.error ? `<p class="err">${esc(S.error)}</p>` : ''}${body}</div></div>`;
}

function vaultCard(d) {
  const avg = d.bought > 0n ? Number(d.spent) / 1e6 / (Number(d.bought) / 1e18) : null;
  const checks = d.bits == null ? `<p class="tiny no">${esc(d.previewError || 'Safety checks unavailable right now.')}</p>`
    : `<ul class="checks">${CHECKS.map(([label, bit, inverse]) => {
      const on = (d.bits >> bit) & 1; const pass = inverse ? !on : !!on;
      return `<li class="${pass ? 'yes' : 'no'}"><span>${pass ? '✓' : '✗'}</span>${esc(label)}</li>`;
    }).join('')}</ul>
    <p class="chip ${d.chip ? 'yes' : 'no'}">TapeOut rule chip #${C.circuitId} says <b>${d.chip ? 'YES' : 'NO'}</b> <span class="mono">(input 0x${d.bits.toString(16).padStart(2, '0')})</span> · <a href="${C.explorer}/address/${C.processor}" target="_blank" rel="noopener">see it on chain</a></p>`;
  const status = d.paused ? '<span class="pill no">Paused</span>' : d.allow ? '<span class="pill yes">Ready to buy</span>' : '<span class="pill">Waiting</span>';
  const nextLine = d.paused ? 'Paused. Nothing will be bought until you resume.'
    : d.balance === 0n ? 'Add USDT0 so Latch has something to buy with.'
    : d.allow ? 'All checks pass. The helper bot buys within about a minute.'
    : ((d.bits >> 3) & 1) === 0 ? `Waiting for OKB to reach your price (average now ${d.twap ? d.twap.toFixed(2) : '…'}, your limit ${usd(d.maxPrice)}).`
    : ((d.bits >> 5) & 1) === 0 ? (d.nextBuyAt > 0n ? `Next buy ${when(d.nextBuyAt)}.` : 'Today’s limit is used up. Next buy tomorrow (UTC).')
    : 'Waiting.';
  const hist = d.history == null ? '<p class="tiny">Recent buys could not be loaded.</p>'
    : d.history.length ? `<table class="hist"><tr><th>Paid</th><th>Got</th><th>Rule chip</th><th></th></tr>${d.history.map((h) => `<tr><td class="mono">${usd(h.inn)} USDT0</td><td class="mono">${okb(h.out)} OKB</td><td class="mono yes">YES 0x${h.bits.toString(16)}</td><td>${link(h.hash, 'tx')}</td></tr>`).join('')}</table>`
    : '<p class="tiny">No buys in the last few hours.</p>';
  const busy = S.busy ? 'disabled' : '';
  return `<article class="card vault" data-v="${d.address}">
    <div class="row between"><h3>${esc(strategyText(d))}</h3>${status}</div>
    <div class="stats">
      <div><span class="k">USDT0 left to spend</span><span class="v mono">${usd(d.balance)}</span></div>
      <div><span class="k">OKB bought</span><span class="v mono">${okb(d.bought)}</span></div>
      <div><span class="k">Average price paid</span><span class="v mono">${avg ? avg.toFixed(2) : '—'}</span></div>
      <div><span class="k">Buys</span><span class="v mono">${d.buys}</span></div>
    </div>
    <p class="next">${esc(nextLine)}</p>
    <details><summary>Safety checks for the next buy</summary>${checks}</details>
    <details><summary>Recent buys</summary>${hist}</details>
    <div class="row gap wrap actions">
      <button class="btn sm amber" data-a="addFunds" ${busy}>Add USDT0</button>
      <button class="btn sm" data-a="${d.paused ? 'resume' : 'pause'}" ${busy}>${d.paused ? 'Resume' : 'Pause'}</button>
      <button class="btn sm" data-a="setPrice" ${busy}>Change price</button>
      <button class="btn sm" data-a="setEvery" ${busy}>Change spacing</button>
      <button class="btn sm ghost" data-a="withdraw" ${busy}>Withdraw all</button>
    </div>
    <p class="tiny">Vault ${link(d.address)} · OKB goes to ${link(d.savings)} · bot ${d.keeper.toLowerCase() === (S.hostedKeeper || '').toLowerCase() ? 'Latch hosted' : link(d.keeper)} · fee ${(Number(d.bps) / 100).toFixed(2)}%</p>
  </article>`;
}

function dashboard() {
  if (!S.account) return '';
  const list = S.vaults.length ? S.vaults.map(vaultCard).join('')
    : `<div class="card empty"><p>You don't have a vault yet.</p><button class="btn amber" data-a="wizard">Create my vault</button></div>`;
  return `<section id="vaults"><div class="row between"><h2>Your vaults</h2><button class="btn sm ghost" data-a="refresh">${S.loading ? 'Loading…' : 'Refresh'}</button></div>
    ${S.error && !S.wizard ? `<p class="err">${esc(S.error)}</p>` : ''}${list}
    ${S.txs.length ? `<p class="tiny">Last: ${esc(S.txs[0].label)} · ${esc(S.txs[0].state)} · ${link(S.txs[0].hash, 'tx')}</p>` : ''}</section>`;
}

function info() {
  return `<section class="cols" id="how">
    <div class="card"><h3>1. Create</h3><p>Pick <b>Buy the dip</b> or <b>Auto-DCA</b>, choose your amount and price. One transaction from your OKX Wallet creates a vault that only you own.</p></div>
    <div class="card"><h3>2. Fund</h3><p>Send USDT0 into your vault. It stays yours: you can pause or take it all back at any time.</p></div>
    <div class="card"><h3>3. Relax</h3><p>Latch's helper bot checks every minute. When your rules say yes, it buys OKB on Uniswap and it lands in your wallet.</p></div>
  </section>
  <section id="safety" class="card">
    <h2>Why you don't have to trust the bot</h2>
    <p>Normal trading bots hold your keys or exchange API keys. If they're hacked, your account is emptied. Latch's bot has no such power. Before every single buy, your vault checks <b>7 rules on the blockchain</b>, and a <b>TapeOut safety circuit</b> double-checks them:</p>
    <ul class="checks static">${CHECKS.map(([l]) => `<li class="yes"><span>✓</span>${esc(l)}</li>`).join('')}</ul>
    <p>On top of that, the vault refuses to buy if the Uniswap price jumped away from its 30-minute average (a sign of manipulation), and the bot refuses if Uniswap disagrees with the big exchanges. <b>Worst case if the bot's key were stolen:</b> it could buy your chosen amount of OKB, at your price or better, into your own wallet. That's all.</p>
  </section>
  <section class="cols">
    <div class="card"><h3>Fees</h3><p>1% of each buy, falling to 0.75%, 0.5% and 0.25% as your vault's volume grows. No sign-up fee, no withdrawal fee. Gas for buys is paid by Latch's bot.</p></div>
    <div class="card"><h3>Who it's for</h3><p>OKX Wallet users who want to build an OKB position without watching charts or keeping coins on an exchange, and builders who need hard spending limits for their bots or AI agents.</p></div>
    <div class="card"><h3>Open & audited</h3><p>Contracts are open source, checked with Slither and two independent reviews, and tested against Uniswap's real code. <a href="${C.repo}" target="_blank" rel="noopener">Read the code and audit</a>.</p></div>
  </section>
  <section class="card faq"><h2>Questions</h2>
    <details><summary>Can Latch take my money?</summary><p>No. Only the wallet that created the vault can withdraw. Latch's bot can only trigger buys within your rules, into your wallet.</p></details>
    <details><summary>What if OKB never reaches my price?</summary><p>Then nothing is bought and your USDT0 stays in the vault. Change the price or withdraw any time.</p></details>
    <details><summary>Which wallet do I need?</summary><p>OKX Wallet works best: the browser extension on a computer, or open this page inside the OKX Wallet app on your phone (Discover tab).</p></details>
    <details><summary>What are the risks?</summary><p>OKB's price can fall after you buy. USDT0 is issued by a company that can freeze addresses. Smart contracts can have bugs; Latch's are reviewed and tested, but start small.</p></details>
  </section>`;
}

function render() {
  const app = document.getElementById('app');
  const focus = document.activeElement?.id;
  app.innerHTML = header() + `<main>${hero()}${S.note ? `<p class="note">${esc(S.note)}</p>` : ''}${dashboard()}${info()}</main>
    <footer>Latch · built on X Layer with TapeOut · <a href="${C.repo}" target="_blank" rel="noopener">GitHub</a> · factory ${link(C.factory)}</footer>` + wizardView();
  if (focus) document.getElementById(focus)?.focus();
}

/* ---------------------------------------------------------------- actions */
function readWizardForm() {
  const w = S.wizard; const g = (id) => document.getElementById(id);
  for (const k of ['perBuy', 'price', 'perDay', 'every', 'savings', 'botAddr', 'deposit']) if (g('f-' + k)) w[k] = g('f-' + k).value.trim();
  if (g('f-ownBot')) w.ownBot = g('f-ownBot').checked;
}
function validate(w) {
  if (!(Number(w.perBuy) > 0)) return 'Enter an amount per buy above 0.';
  if (!(Number(w.price) > 0)) return 'Enter a price above 0.';
  if (w.strategy === 'dip' && !(Number(w.perDay) >= 1)) return 'Most buys per day must be at least 1.';
  if (!isAddress(w.savings)) return 'The "send the OKB to" address is not valid.';
  if (w.ownBot && !isAddress(w.botAddr)) return 'Your bot address is not valid.';
  return '';
}
async function act(a, el) {
  const card = el.closest('[data-v]'); const v = card?.dataset.v;
  const d = S.vaults.find((x) => x.address === v);
  S.error = '';
  switch (a) {
    case 'connect': return connect();
    case 'refresh': return refresh();
    case 'wizard': {
      if (!S.account) { await connect(); if (!S.account) return; }
      const p = S.price || 80;
      S.wizard = { step: 0, strategy: '', perBuy: '5', price: (Math.floor(p * 0.9 * 10) / 10).toString(), perDay: '2', every: '604800', savings: S.account, ownBot: false, botAddr: '', deposit: '20' };
      return render();
    }
    case 'closeWizard': S.wizard = null; return refresh();
    case 'strategy': S.wizard.strategy = el.dataset.v; if (el.dataset.v === 'dca') S.wizard.price = String(Math.ceil((S.price || 80) * 1.5)); return render();
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
      const x = prompt('How much USDT0 to add?', '10'); if (!x) return;
      const r = await send('Adding USDT0', { address: C.usdt, abi: ERC20, functionName: 'transfer', args: [v, parseUnits(x, 6)] });
      if (r) await refresh(); return;
    }
    case 'pause': case 'resume': {
      const r = await send(a === 'pause' ? 'Pausing' : 'Resuming', { address: v, abi: VAULT, functionName: 'setPaused', args: [a === 'pause'] });
      if (r) await refresh(); return;
    }
    case 'setPrice': {
      const x = prompt(d.minInterval >= 86400n ? 'Never pay more than (USDT0 per OKB):' : 'Buy when OKB is at or below (USDT0):', usd(d.maxPrice).replace(/,/g, ''));
      if (!x) return;
      const r = await send('Changing price', { address: v, abi: VAULT, functionName: 'setMaxPrice', args: [parseUnits(x, 6)] });
      if (r) await refresh(); return;
    }
    case 'setEvery': {
      const x = prompt('Minimum hours between buys (0 = no spacing, 24 = daily, 168 = weekly):', String(Number(d.minInterval) / 3600));
      if (x == null || x === '') return;
      const r = await send('Changing spacing', { address: v, abi: VAULT, functionName: 'setMinInterval', args: [BigInt(Math.round(Number(x) * 3600))] });
      if (r) await refresh(); return;
    }
    case 'withdraw': {
      if (!confirm('Withdraw all USDT0 from this vault back to your wallet? You can pause first if you also want buying to stop.')) return;
      const r = await send('Withdrawing', { address: v, abi: VAULT, functionName: 'withdraw', args: [C.usdt, S.account, MAX] });
      if (r) await refresh(); return;
    }
  }
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]'); if (!el || el.disabled) return;
  e.preventDefault(); act(el.dataset.a, el);
});

render();
refresh();
setInterval(() => { if (!S.busy && !S.wizard) refresh(); }, 60_000);
window.__latch = S; // for tests and debugging
