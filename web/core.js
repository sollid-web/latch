// Latch web core: chain + contracts, wallet connection (extension, in-app browser, OKX Connect on phones),
// transactions with plain-English errors, event-log search, formatting. Pages live in app.js.
import { OKXUniversalProvider, ConnectWalletType } from '@okxconnect/universal-provider';
import {
  createPublicClient, createWalletClient, custom, fallback, http, parseAbi, parseAbiItem,
  formatUnits, getAddress, decodeErrorResult
} from 'viem';

export const C = window.LATCH_CONFIG;
export const U6 = 10n ** 6n;
export const E18 = 10n ** 18n;
export const MAX = 2n ** 256n - 1n;
export const ZERO = '0x0000000000000000000000000000000000000000';

export const chain = {
  id: C.chainId, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: C.rpc } }, blockExplorers: { default: { name: 'OKLink', url: C.explorer } }
};
export const pub = createPublicClient({ chain, transport: fallback(C.rpc.map((u) => http(u, { timeout: 12_000 }))) });

/* ---------------------------------------------------------------- contracts */
export const FACTORY1 = parseAbi([
  'function vaultsOf(address owner) view returns (address[])',
  'function vaultCount() view returns (uint256)',
  'function hostedKeeper() view returns (address)',
  'function vaultsPage(uint256 start, uint256 count) view returns (address[])'
]);
export const VAULT1 = parseAbi([
  'function owner() view returns (address)',
  'function maxPrice() view returns (uint256)',
  'function minInterval() view returns (uint256)',
  'function nextBuyAt() view returns (uint256)',
  'function lastBuyAt() view returns (uint256)',
  'function volumeSwept() view returns (uint256)',
  'function totalBought() view returns (uint256)',
  'function buys() view returns (uint256)',
  'function status() view returns (address,bool,bool,uint256,uint256,uint256,uint256,address,address,address)',
  'function setPaused(bool next)',
  'function withdraw(address token, address to, uint256 amount)'
]);
export const FACTORY2 = parseAbi([
  'function createVault(uint8 direction, uint8 mode, address savings, uint256 baseAmount, uint256 perTxCap, uint256 dailyCap, uint256 refPrice, uint256 limitPrice, uint256 minInterval, address keeper) returns (address)',
  'function vaultsOf(address owner) view returns (address[])',
  'function vaultCount() view returns (uint256)',
  'function vaultsPage(uint256 start, uint256 count) view returns (address[])',
  'function hostedKeeper() view returns (address)',
  'function treasury() view returns (address)',
  'function minBuy() view returns (uint256)',
  'function minSell() view returns (uint256)'
]);
export const VAULT2 = parseAbi([
  'function owner() view returns (address)',
  'function keeper() view returns (address)',
  'function savings() view returns (address)',
  'function paused() view returns (bool)',
  'function direction() view returns (uint8)',
  'function mode() view returns (uint8)',
  'function tokenIn() view returns (address)',
  'function tokenOut() view returns (address)',
  'function baseAmount() view returns (uint256)',
  'function perTxCap() view returns (uint256)',
  'function dailyCap() view returns (uint256)',
  'function refPrice() view returns (uint256)',
  'function limitPrice() view returns (uint256)',
  'function minInterval() view returns (uint256)',
  'function minAmount() view returns (uint256)',
  'function lastTradeAt() view returns (uint256)',
  'function nextTradeAt() view returns (uint256)',
  'function spentTodayNow() view returns (uint256)',
  'function volumeIn() view returns (uint256)',
  'function volumeQuote() view returns (uint256)',
  'function totalOut() view returns (uint256)',
  'function trades() view returns (uint256)',
  'function feeBpsNow() view returns (uint256)',
  'function twapPrice() view returns (uint256)',
  'function preview(address caller) view returns (uint16 inputs, uint8 k, uint256 amount, uint256 fee, uint256 minOut, uint256 avgPrice)',
  'function chip(uint16 inputs) view returns (bool allow, uint8 k)',
  'function setPaused(bool next)',
  'function setStrategy(uint256 baseAmount, uint256 perTxCap, uint256 dailyCap, uint256 refPrice, uint256 limitPrice, uint256 minInterval, uint8 mode)',
  'function withdraw(address token, address to, uint256 amount)',
  'error NotOwner()', 'error NotKeeper()', 'error Paused()', 'error OverCap()', 'error Underfunded()', 'error TransferFailed()',
  'error ZeroAddress()', 'error CapRaised()', 'error Reentered()', 'error BadRecipient()', 'error BadPool()', 'error BadParam()',
  'error AlreadyInitialized()', 'error PriceOutside(uint256,uint256)', 'error PriceUnstable()', 'error TooSoon(uint256)',
  'error ChipSaysNo(uint16)', 'error BadEval()', 'error SwapShort(uint256,uint256)', 'error SwapAccounting()', 'error BadSavings()', 'error NotAdmin()'
]);
export const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)'
]);
export const WOKB_ABI = parseAbi(['function deposit() payable', 'function withdraw(uint256 wad)']);
export const POOL = parseAbi(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function token0() view returns (address)', 'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)']);
export const PROC = parseAbi(['function eval(uint256 id, bytes inputs) view returns (bytes)']);
export const BOUGHT = parseAbiItem('event Bought(address indexed keeper, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 twapPrice, uint8 bits)');
export const TRADED = parseAbiItem('event Traded(address indexed keeper, uint8 direction, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 twapPrice, uint16 inputs, uint8 multiplier)');

const ERRORS_PLAIN = {
  NotOwner: 'Only the vault owner can do that. Connect the wallet that created this vault.',
  Underfunded: 'Not enough funds for that.',
  BadParam: 'A value is outside the allowed range (prices above 0, spacing at most 30 days).',
  CapRaised: 'Limits can only be lowered, never raised. That is a safety rule: make a new vault for bigger limits.',
  BadRecipient: 'That address cannot receive from a vault (it is a token or system contract). Use your own wallet address.',
  ZeroAddress: 'An address is missing.',
  OverCap: 'Check the amounts: the trade size must be at least the minimum, the most per trade at least the trade size, and the daily limit at least the most per trade.',
  BadSavings: 'That wallet cannot receive the output (it is Latch’s fee wallet, a bot, or another vault). Choose another wallet address.',
  ChipSaysNo: 'The strategy chip says no right now.',
  PriceOutside: 'The price is outside your limit right now.',
  PriceUnstable: 'The price is moving too fast right now.'
};

/* ---------------------------------------------------------------- state + render hook */
export const S = {
  page: 'home', account: null, walletChain: null, provider: null, walletName: '',
  price: null, error: '', note: '', busy: '', txs: [], open: {}, blocks: new Map()
};
let renderFn = () => {};
let refreshFn = async () => {};
export function hooks(render, refresh) { renderFn = render; refreshFn = refresh; }
const render = () => renderFn();

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
/** OKX's App Universal Link (opens this page in the OKX app's DApp browser). */
export function okxAppLink(url = location.href) {
  const inner = 'okx://wallet/dapp/url?dappUrl=' + encodeURIComponent(url);
  return 'https://web3.okx.com/download?deeplink=' + encodeURIComponent(inner);
}
/** The standalone OKX Wallet app's own scheme (opens the Web3 wallet app, not the exchange app). */
export function okxWalletLink(url = location.href) {
  return 'okxwallet://wallet/dapp/url?dappUrl=' + encodeURIComponent(url);
}
export const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900);

/* OKX Connect (OKX's official SDK): from a normal phone browser, asks the standalone OKX Wallet app
   (ConnectWalletType.OKX_WALLET, not the exchange app) to approve, then you come back here connected. */
let okxConnectP = null;
function okxConnect() {
  if (!okxConnectP) {
    okxConnectP = OKXUniversalProvider.init({ dappMetaData: { name: 'Latch', icon: location.origin + '/icon.png' } }).then((okx) => {
      okx.on('session_delete', () => { // disconnected from the wallet app's side
        if (S.walletName === 'OKX Wallet app') { S.account = null; S.provider = null; refreshFn(); }
      });
      okx.on('session_update', () => { const a = sessionAccount(okx); if (a && S.walletName === 'OKX Wallet app') { S.account = a; render(); } });
      return okx;
    });
  }
  return okxConnectP;
}
/** The approved X Layer account from OKX Connect's saved session (no network needed). */
function sessionAccount(okx) {
  try {
    const list = okx.session?.namespaces?.eip155?.accounts || [];
    const a = list.find((x) => String(x).startsWith(XL + ':')) || list[0];
    return a ? getAddress(String(a).split(':').pop()) : null;
  } catch { return null; }
}
function useOkxSession(okx, account) {
  S.provider = okxAsEip1193(okx); S.walletName = 'OKX Wallet app'; S.account = account; S.walletChain = C.chainId;
  S.note = ''; S.mobileHelp = false;
}
/** On load, and whenever you come back to this tab: if you already approved Latch in the OKX Wallet app,
 *  show you as connected. Phones pause or reload the tab while the wallet app is open, so the page cannot
 *  rely on still being there when the approval arrives. */
const SILENT_OFF = 'latch.disconnected';
function listen(p) {
  if (!p.on || p.__latch) return;
  p.__latch = true;
  p.on('accountsChanged', (a) => { S.account = a?.[0] ? getAddress(a[0]) : null; refreshFn(); });
  p.on('chainChanged', (id) => { S.walletChain = Number(id); render(); });
}
/** Wallet already approved this site (extension or OKX app browser): show it connected after a reload, without a prompt. */
async function restoreInjected() {
  const w = findWallet();
  if (!w) return false;
  try { if (localStorage.getItem(SILENT_OFF)) return false; } catch {}
  try {
    const a = await w.p.request({ method: 'eth_accounts' });
    if (!a?.[0] || S.account) return false;
    S.provider = w.p; S.walletName = w.name; S.account = getAddress(a[0]);
    S.walletChain = Number(await w.p.request({ method: 'eth_chainId' }).catch(() => C.chainId));
    listen(w.p);
    return true;
  } catch { return false; }
}
export async function restoreSession() {
  if (S.account) return false;
  if (window.okxwallet || window.ethereum || announced.length) return restoreInjected();
  if (C.onchain || (!okxConnectP && !isMobile())) return false;
  try {
    const okx = await okxConnect();
    if (!okx.connected()) return false;
    const a = sessionAccount(okx);
    if (!a) return false;
    useOkxSession(okx, a);
    return true;
  } catch { return false; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || S.account) return;
  setTimeout(() => restoreSession().then((ok) => { if (ok) refreshFn(); }), 800);
});
const XL = 'eip155:' + C.chainId;
function okxAsEip1193(okx) {
  return {
    request: ({ method, params }) => {
      if (method === 'eth_chainId') return Promise.resolve('0x' + C.chainId.toString(16));
      if (method === 'wallet_switchEthereumChain') return Promise.resolve(null);
      return okx.request({ method, params }, XL);
    },
    on() {}, removeListener() {}
  };
}
async function connectOkxApp() {
  const okx = await okxConnect();
  if (okx.connected()) {
    const a = sessionAccount(okx);
    if (a) return { okx, account: a };
    try { await Promise.race([okx.disconnect(), new Promise((r) => setTimeout(r, 1500))]); } catch { /* start fresh below */ }
  }
  const session = await okx.connect({
    namespaces: { eip155: { chains: [XL], defaultChain: String(C.chainId), rpcMap: { [String(C.chainId)]: C.rpc[0] } } },
    sessionConfig: { redirect: 'none', connectWalletType: ConnectWalletType.OKX_WALLET }
  });
  const acct = session?.namespaces?.eip155?.accounts?.find((a) => a.startsWith(XL + ':')) || session?.namespaces?.eip155?.accounts?.[0];
  if (!acct) throw new Error('The wallet app did not return an X Layer account.');
  return { okx, account: getAddress(acct.split(':').pop()) };
}
if (typeof window !== 'undefined' && !C.onchain && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') && !window.okxwallet && !window.ethereum) {
  okxConnect().catch(() => {}); // warm up, so the tap opens the app without delay (iOS blocks slow hand-offs)
}

export async function connect() {
  let w = findWallet();
  if (!w && isMobile() && C.onchain) {
    // On-chain copy (DeWEB): OKX Connect's relay is off-chain, so open this page inside the OKX Wallet app instead.
    S.note = ''; S.mobileHelp = true; render();
    return;
  }
  if (!w && isMobile() && !window.okxwallet && !window.ethereum) {
    S.note = 'Opening the OKX Wallet app… approve the connection there, then come back to this page.'; S.mobileHelp = false; render();
    // If the app has not opened after a few seconds (page still on screen), say so plainly.
    const watch = setTimeout(() => {
      if (!S.account && document.visibilityState === 'visible') {
        S.note = 'The OKX Wallet app did not open by itself. Tap "Open in OKX Wallet app" below.'; S.mobileHelp = true; render();
      }
    }, 6000);
    try {
      const r = await connectOkxApp();
      clearTimeout(watch);
      useOkxSession(r.okx, r.account);
      await refreshFn();
      return;
    } catch (e) {
      clearTimeout(watch);
      if (await restoreSession()) { await refreshFn(); return; } // approved while this tab was paused
      S.note = 'Could not connect through the OKX Wallet app (' + plain(e) + '). Use the steps below instead.';
      S.mobileHelp = true; render();
      return;
    }
  }
  for (let i = 0; !w && i < 6; i++) { // in-app wallet browsers can inject their provider a little late
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch { /* old browsers */ }
    await new Promise((r) => setTimeout(r, 500));
    w = findWallet();
  }
  if (!w) {
    S.mobileHelp = true; S.note = isMobile() ? '' : 'No wallet found in this browser. On a computer, install the OKX Wallet extension and reload. On a phone, follow the steps below.';
    render();
    return;
  }
  S.provider = w.p; S.walletName = w.name; S.note = '';
  try {
    const accts = await w.p.request({ method: 'eth_requestAccounts' });
    S.account = accts?.[0] ? getAddress(accts[0]) : null;
    S.walletChain = Number(await w.p.request({ method: 'eth_chainId' }));
    if (S.walletChain !== C.chainId) await switchChain();
    listen(w.p);
    try { localStorage.removeItem(SILENT_OFF); } catch {}
  } catch (e) {
    S.note = e?.code === 4001 ? 'You rejected the connection in your wallet.'
      : e?.code === -32002 ? 'Your wallet already has a request waiting. Open the wallet and answer it.'
      : plain(e);
  }
  await refreshFn();
}
export async function disconnect() {
  // OKX Connect sessions are ended for real; extension wallets keep the site in their own connected-sites list.
  try { if (okxConnectP) { const okx = await okxConnectP; if (okx.connected()) await okx.disconnect(); } } catch { /* already gone */ }
  S.account = null; S.provider = null;
  try { localStorage.setItem(SILENT_OFF, '1'); } catch {}
  S.note = 'Disconnected. To remove Latch completely, also remove it from the connected sites list in your wallet.';
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
const wallet = () => createWalletClient({ account: S.account, chain, transport: custom(S.provider) });

/* ---------------------------------------------------------------- transactions */
export function plain(e) {
  const data = e?.cause?.data || e?.data || e?.cause?.cause?.data;
  const name = e?.cause?.data?.errorName || (() => {
    try { return typeof data === 'string' ? decodeErrorResult({ abi: VAULT2, data }).errorName : null; } catch { return null; }
  })();
  if (name && ERRORS_PLAIN[name]) return ERRORS_PLAIN[name];
  if (e?.code === 4001 || /rejected|denied/i.test(e?.message || '')) return 'You cancelled it in your wallet.';
  return String(e?.shortMessage || e?.message || e).split('\n')[0];
}
/** Simulate (shows the real reason before the wallet pops up), send, wait. Returns the receipt or null. */
export async function send(label, req) {
  if (!S.account) { await connect(); if (!S.account) return null; }
  if (S.walletChain !== C.chainId) { try { await switchChain(); } catch (e) { S.error = plain(e); render(); return null; } }
  S.busy = label; S.error = ''; render();
  try {
    await pub.simulateContract({ account: S.account, ...req });
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

/* ---------------------------------------------------------------- event logs
 * The public X Layer RPC refuses eth_getLogs over more than 100 blocks, so searches are split into 100-block
 * pieces around each vault's own last-trade time (found by timestamp), instead of scanning blindly. */
const LOG_SPAN = 100n;
async function logsIn(address, event, from, to) {
  const ranges = [];
  for (let a = from; a <= to; a += LOG_SPAN) ranges.push([a, a + LOG_SPAN - 1n < to ? a + LOG_SPAN - 1n : to]);
  const out = [];
  for (let i = 0; i < ranges.length; i += 4) {
    const parts = await Promise.all(ranges.slice(i, i + 4).map(([a, b]) => pub.getLogs({ address, event, fromBlock: a, toBlock: b })));
    for (const p of parts) out.push(...p);
  }
  return out;
}
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
    let m = i % 2 === 0 && hi.t > lo.t ? lo.n + ((hi.n - lo.n) * (ts - lo.t)) / (hi.t - lo.t) : lo.n + (hi.n - lo.n) / 2n;
    if (m <= lo.n) m = lo.n + 1n;
    if (m >= hi.n) m = hi.n - 1n;
    const b = await pub.getBlock({ blockNumber: m });
    if (b.timestamp < ts) lo = { n: m, t: b.timestamp }; else hi = { n: m, t: b.timestamp };
  }
  S.blocks.set(key, hi.n);
  return hi.n;
}
/** Trades of one vault around its latest one (newest first). v = 1 (Bought) or 2 (Traded). */
export async function tradesOf(address, version, last, head, back = 1200n) {
  if (!last) return [];
  const b = await blockAt(last, head);
  const to = b + LOG_SPAN - 1n < head.number ? b + LOG_SPAN - 1n : head.number;
  const logs = await logsIn(address, version === 2 ? TRADED : BOUGHT, b > back ? b - back : 0n, to);
  return logs.reverse().slice(0, 10).map((l) => ({
    vault: l.address, version, hash: l.transactionHash, block: l.blockNumber,
    dir: version === 2 ? Number(l.args.direction) : 0, inn: l.args.amountIn, out: l.args.amountOut, fee: l.args.fee,
    price: l.args.twapPrice, k: version === 2 ? Number(l.args.multiplier) : 1, inputs: version === 2 ? Number(l.args.inputs) : Number(l.args.bits)
  }));
}

/* ---------------------------------------------------------------- formatting */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const usd = (v, d = 2) => Number(formatUnits(v, 6)).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) });
export const okb = (v, d = 6) => Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: d });
export const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
export const link = (a, kind = 'address', text) => `<a href="${C.explorer}/${kind}/${a}" target="_blank" rel="noopener">${esc(text || short(a))}</a>`;
export const when = (ts) => { const d = Number(ts) * 1000 - Date.now(); if (d <= 0) return 'now'; const h = Math.floor(d / 3.6e6), m = Math.ceil((d % 3.6e6) / 6e4); return h >= 48 ? `${Math.round(h / 24)} days` : h ? `${h} h ${m} min` : `${m} min`; };
export const spacingText = (s) => s >= 604800n ? 'at most once a week' : s >= 86400n ? 'at most once a day' : s >= 3600n ? `at most every ${Number(s / 3600n)} h` : s > 0n ? `at most every ${Number(s / 60n)} min` : 'whenever the chip allows';
