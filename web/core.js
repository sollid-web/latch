// Latch web core: chain + contracts, wallet connection (extension, in-app browser, OKX Connect on phones),
// transactions with plain-English errors, event-log search, formatting. Pages live in app.js.
import { OKXUniversalProvider, ConnectWalletType } from '@okxconnect/universal-provider';
import UniversalProvider from '@walletconnect/universal-provider';
import QRCode from 'qrcode';
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
// Connect shows a picker: wallets found in this browser (each by name, EIP-6963), "scan with a phone wallet"
// (WalletConnect QR: OKX Wallet, MetaMask, Trust, Bitget and any other WalletConnect wallet that supports
// X Layer), and on phones the OKX Wallet app (OKX Connect). Nothing connects without the person choosing.
const announced = [];
window.addEventListener('eip6963:announceProvider', (e) => {
  const d = e?.detail; if (!d?.provider) return;
  const id = d.info?.rdns || d.info?.uuid || d.info?.name;
  if (!announced.some((x) => (x.info?.rdns || x.info?.uuid || x.info?.name) === id)) { announced.push(d); render(); }
});
const askWallets = () => { try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch { /* old browsers */ } };
askWallets();
const safeIcon = (u) => (typeof u === 'string' && /^data:image\/(png|svg\+xml|jpeg|webp|gif);/i.test(u) ? u : '');
/** Wallets in this browser (extensions, or the wallet app's own browser), newest standard first. */
export function browserWallets() {
  const list = announced.map((d) => ({ id: 'inj:' + (d.info?.rdns || d.info?.uuid || d.info?.name), name: d.info?.name || 'Browser wallet', icon: safeIcon(d.info?.icon), p: d.provider }));
  if (!list.length && window.okxwallet) list.push({ id: 'inj:okxwallet', name: 'OKX Wallet', icon: '', p: window.okxwallet });
  if (!list.length && window.ethereum) list.push({ id: 'inj:ethereum', name: window.ethereum.isMetaMask ? 'MetaMask' : 'Browser wallet', icon: '', p: window.ethereum });
  return list;
}
function findWallet(id) {
  const all = browserWallets();
  return (id && all.find((w) => w.id === id)) || all.find((w) => /okx|okex/i.test(w.id + w.name)) || all[0] || null;
}
export const hasWalletConnect = () => !C.onchain && !!C.wcProjectId;
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
const XL = 'eip155:' + C.chainId;
const LAST = 'latch.wallet';      // which kind of wallet you chose last: 'inj:<rdns>', 'wc' or 'okx'
const SILENT_OFF = 'latch.disconnected';
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } }
};
function connected(provider, name, account, kind) {
  S.provider = provider; S.walletName = name; S.account = account; S.picker = null; S.note = ''; S.mobileHelp = false;
  store.set(LAST, kind); store.set(SILENT_OFF, null);
}
function wrapSession(request) { // OKX Connect / WalletConnect → the small EIP-1193 surface viem needs
  return {
    request: ({ method, params }) => {
      if (method === 'eth_chainId') return Promise.resolve('0x' + C.chainId.toString(16));
      if (method === 'wallet_switchEthereumChain') return Promise.resolve(null);
      return request({ method, params });
    },
    on() {}, removeListener() {}
  };
}
const pickAccount = (list) => {
  const a = (list || []).find((x) => String(x).startsWith(XL + ':')) || null;
  return a ? getAddress(String(a).split(':').pop()) : null;
};

/* OKX Connect (OKX's official SDK): from a normal phone browser, asks the standalone OKX Wallet app
   (ConnectWalletType.OKX_WALLET, not the exchange app) to approve, then you come back here connected. */
let okxConnectP = null;
function okxConnect() {
  if (!okxConnectP) {
    okxConnectP = OKXUniversalProvider.init({ dappMetaData: { name: 'Latch', icon: location.origin + '/icon.png' } }).then((okx) => {
      okx.on('session_delete', () => { if (store.get(LAST) === 'okx') { S.account = null; S.provider = null; refreshFn(); } });
      okx.on('session_update', () => { const a = pickAccount(okx.session?.namespaces?.eip155?.accounts); if (a && store.get(LAST) === 'okx') { S.account = a; render(); } });
      return okx;
    });
  }
  return okxConnectP;
}
const useOkx = (okx, a) => connected(wrapSession((x) => okx.request(x, XL)), 'OKX Wallet app', a, 'okx');
async function connectOkxApp() {
  const okx = await okxConnect();
  if (okx.connected()) { try { await Promise.race([okx.disconnect(), new Promise((r) => setTimeout(r, 1500))]); } catch { /* start fresh */ } }
  const session = await okx.connect({
    namespaces: { eip155: { chains: [XL], defaultChain: String(C.chainId), rpcMap: { [String(C.chainId)]: C.rpc[0] } } },
    sessionConfig: { redirect: 'none', connectWalletType: ConnectWalletType.OKX_WALLET }
  });
  const a = pickAccount(session?.namespaces?.eip155?.accounts) || pickAccount((session?.namespaces?.eip155?.accounts || []).map((x) => XL + ':' + String(x).split(':').pop()));
  if (!a) throw new Error('The wallet app did not return an X Layer account.');
  useOkx(okx, a);
}

/* WalletConnect: a QR code any phone wallet can scan (or, on a phone, a link that opens the wallet app). */
let wcP = null;
function wcInit() {
  if (!hasWalletConnect()) return Promise.reject(new Error('Scanning is not set up on this copy of Latch.'));
  if (!wcP) {
    wcP = UniversalProvider.init({
      projectId: C.wcProjectId,
      metadata: { name: 'Latch', description: 'Rule-bound OKB vaults on X Layer', url: location.origin, icons: [location.origin + '/icon.png'] }
    }).then((p) => {
      p.on('display_uri', async (uri) => {
        if (!S.picker) return;
        S.picker.uri = uri;
        try { S.picker.qr = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }); } catch { S.picker.qr = ''; }
        render();
      });
      p.on('session_delete', () => { if (store.get(LAST) === 'wc') { S.account = null; S.provider = null; refreshFn(); } });
      p.on('accountsChanged', (a) => { if (store.get(LAST) === 'wc' && a?.[0]) { S.account = getAddress(String(a[0]).split(':').pop()); refreshFn(); } });
      return p;
    });
    wcP.catch(() => { wcP = null; });
  }
  return wcP;
}
const useWc = (p, a) => connected(wrapSession((x) => p.request(x, XL)), p.session?.peer?.metadata?.name || 'Phone wallet', a, 'wc');
async function connectWc() {
  const p = await wcInit();
  if (p.session) { try { await p.disconnect(); } catch { /* start fresh */ } }
  const session = await p.connect({
    optionalNamespaces: {
      eip155: {
        chains: [XL],
        methods: ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'wallet_addEthereumChain'],
        events: ['accountsChanged', 'chainChanged'],
        rpcMap: { [String(C.chainId)]: C.rpc[0] }
      }
    }
  });
  const a = pickAccount(session?.namespaces?.eip155?.accounts);
  if (!a) {
    try { await p.disconnect(); } catch { /* ignore */ }
    throw new Error('That wallet did not share an X Layer account. Use a wallet that supports X Layer (OKX Wallet, Bitget Wallet, MetaMask with X Layer added).');
  }
  useWc(p, a);
}
export function cancelWc() {
  if (S.picker) { S.picker.step = 'list'; S.picker.uri = ''; S.picker.qr = ''; S.picker.busy = ''; S.picker.cancelled = true; }
  wcP?.then((p) => { try { p.abortPairingAttempt?.(); } catch { /* nothing pending */ } }).catch(() => {});
}

/* Browser wallets: always ask the wallet, so you can pick (or switch) the account each time. */
function listen(p) {
  if (!p.on || p.__latch) return;
  p.__latch = true;
  p.on('accountsChanged', (a) => { if (S.provider !== p) return; S.account = a?.[0] ? getAddress(a[0]) : null; refreshFn(); });
  p.on('chainChanged', (id) => { if (S.provider !== p) return; S.walletChain = Number(id); render(); });
}
async function connectInjected(w) {
  try { await w.p.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }); } // shows the account chooser
  catch (e) { if (e?.code === 4001) throw e; /* wallet without this method: the normal request below */ }
  const accts = await w.p.request({ method: 'eth_requestAccounts' });
  if (!accts?.[0]) throw new Error('The wallet did not share an account.');
  connected(w.p, w.name, getAddress(accts[0]), w.id);
  S.walletChain = Number(await w.p.request({ method: 'eth_chainId' }));
  listen(w.p);
  if (S.walletChain !== C.chainId) await switchChain();
}

/** Show the wallet you already chose after a reload (no prompt). Never after you pressed Disconnect. */
export async function restoreSession() {
  if (S.account || store.get(SILENT_OFF)) return false;
  const last = store.get(LAST);
  try {
    if (last === 'wc') {
      if (!hasWalletConnect()) return false;
      const p = await wcInit(); const a = p.session && pickAccount(p.session.namespaces?.eip155?.accounts);
      if (!a || S.account) return false;
      useWc(p, a); return true;
    }
    if (last === 'okx' || (!last && isMobile() && !browserWallets().length)) {
      if (C.onchain) return false;
      const okx = await okxConnect();
      if (!okx.connected()) return false;
      const a = pickAccount(okx.session?.namespaces?.eip155?.accounts);
      if (!a || S.account) return false;
      useOkx(okx, a); return true;
    }
    const w = findWallet(last && last.startsWith('inj:') ? last : null);
    if (!w) return false;
    const a = await w.p.request({ method: 'eth_accounts' });
    if (!a?.[0] || S.account) return false;
    connected(w.p, w.name, getAddress(a[0]), w.id);
    S.walletChain = Number(await w.p.request({ method: 'eth_chainId' }).catch(() => C.chainId));
    listen(w.p);
    return true;
  } catch { return false; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || S.account) return;
  setTimeout(() => restoreSession().then((ok) => { if (ok) refreshFn(); }), 800);
});
if (typeof window !== 'undefined' && !C.onchain && isMobile() && !window.okxwallet && !window.ethereum) {
  okxConnect().catch(() => {}); // warm up, so the tap opens the app without delay (iOS blocks slow hand-offs)
}

/** "Connect wallet": inside a wallet app's own browser, connect to it; everywhere else, show the picker. */
export async function connect() {
  S.note = ''; S.mobileHelp = false;
  if (isMobile()) {
    for (let i = 0; !browserWallets().length && (window.okxwallet || window.ethereum) && i < 4; i++) { askWallets(); await new Promise((r) => setTimeout(r, 300)); }
    const list = browserWallets();
    if (list.length === 1) return choose(list[0].id); // the wallet app's own browser: one wallet, nothing to pick
  }
  askWallets();
  S.picker = { step: 'list', busy: '', error: '', uri: '', qr: '' };
  render();
}
export function closePicker() { if (S.picker?.step === 'wc') cancelWc(); S.picker = null; render(); }

/** Picker choice: 'inj:<id>', 'wc' or 'okx'. */
export async function choose(id) {
  if (!S.picker) S.picker = { step: 'list', busy: '', error: '', uri: '', qr: '' };
  const pk = S.picker; pk.error = '';
  try {
    if (id === 'wc') {
      pk.step = 'wc'; pk.busy = 'Making a code'; pk.cancelled = false; render();
      const slow = setTimeout(() => { // the relay never answered: say so instead of spinning forever
        if (S.picker === pk && pk.step === 'wc' && !pk.uri) { cancelWc(); pk.error = 'Could not reach WalletConnect to make a code. Check your internet connection and try again.'; render(); }
      }, 20000);
      try { await connectWc(); } finally { clearTimeout(slow); }
    } else if (id === 'okx') {
      if (C.onchain) { S.picker = null; S.mobileHelp = true; render(); return; }
      pk.busy = 'Opening the OKX Wallet app'; render();
      const watch = setTimeout(() => {
        if (!S.account && S.picker && document.visibilityState === 'visible') { S.picker.error = 'The OKX Wallet app did not open by itself. Use "Open Latch inside your wallet app" below.'; S.picker.busy = ''; render(); }
      }, 6000);
      try { await connectOkxApp(); } finally { clearTimeout(watch); }
    } else {
      const w = browserWallets().find((x) => x.id === id);
      if (!w) throw new Error('That wallet is no longer available in this browser. Reload the page and try again.');
      pk.busy = 'Approve in ' + w.name; render();
      await connectInjected(w);
    }
  } catch (e) {
    if (S.account) return refreshFn();
    if (S.picker !== pk || (id === 'wc' && pk.cancelled)) return; // you closed the picker or went back: nothing to report
    if (id === 'okx' && await restoreSession()) return refreshFn(); // approved while this tab was paused
    S.picker.busy = '';
    if (id === 'wc') { S.picker.step = 'list'; S.picker.uri = ''; S.picker.qr = ''; }
    S.picker.error = e?.code === 4001 || /reject|denied|cancel/i.test(e?.message || '') ? 'You declined in your wallet. Pick a wallet to try again.'
      : e?.code === -32002 ? 'Your wallet already has a request waiting. Open the wallet and answer it.'
      : /expired|proposal/i.test(e?.message || '') ? 'The code expired. Pick "Scan with a phone wallet" again for a new one.'
      : plain(e);
    render();
    return;
  }
  await refreshFn();
}

export async function disconnect() {
  const last = store.get(LAST); const p = S.provider;
  S.account = null; S.provider = null; S.picker = null;
  store.set(SILENT_OFF, '1'); store.set(LAST, null);
  try { if (okxConnectP && last === 'okx') { const okx = await okxConnectP; if (okx.connected()) await okx.disconnect(); } } catch { /* already gone */ }
  try { if (wcP && last === 'wc') { const w = await wcP; if (w.session) await w.disconnect(); } } catch { /* already gone */ }
  try { if (p && last?.startsWith('inj:')) await p.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); } catch { /* not supported by every wallet */ }
  S.note = 'Disconnected. Connect wallet will ask which wallet to use.';
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
/** opts.normalFee: fill in gas limit and price ourselves, so the wallet sends a regular paid transaction
 *  (a fraction of a cent of OKB) instead of routing it through its own free-gas service. */
export async function send(label, req, opts = {}) {
  S.sendErr = null;
  if (!S.account) { await connect(); if (!S.account) return null; }
  if (S.walletChain !== C.chainId) { try { await switchChain(); } catch (e) { S.error = plain(e); render(); return null; } }
  S.busy = label; S.error = ''; render();
  try {
    await pub.simulateContract({ account: S.account, ...req });
    let fee = {};
    if (opts.normalFee) {
      const [gas, gasPrice] = await Promise.all([pub.estimateContractGas({ account: S.account, ...req }), pub.getGasPrice()]);
      fee = { gas: (gas * 13n) / 10n + 5000n, gasPrice: (gasPrice * 12n) / 10n };
    }
    const hash = await wallet().writeContract({ ...req, ...fee, chain });
    S.txs.unshift({ label, hash, state: 'sent' }); render();
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    S.txs[0].state = r.status === 'success' ? 'done' : 'failed';
    if (r.status !== 'success') throw new Error(label + ' failed on chain');
    return r;
  } catch (e) {
    S.sendErr = e;
    S.error = label + ': ' + plain(e);
    return null;
  } finally {
    S.busy = ''; render();
  }
}
/** True when the person said no in their wallet (not a failure worth offering another route for). */
export const declined = (e) => e?.code === 4001 || /reject|denied|cancel/i.test(String(e?.shortMessage || e?.message || e?.details || ''));

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
