// On-chain (DeWEB) build only: WalletConnect needs its relay servers, which the TapeKit gateway does not allow.
// The on-chain copy connects to wallets in the browser (extension or the wallet app's own browser).
export default { init: () => Promise.reject(new Error('not available here')) };
