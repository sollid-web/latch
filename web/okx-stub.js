// On-chain (DeWEB) build only: OKX Connect needs OKX relay servers, which the TapeKit gateway does not allow.
// Phones use the OKX Wallet app browser there instead (the page offers the link).
export const ConnectWalletType = { OKX_WALLET: 'okx_wallet' };
export const OKXUniversalProvider = { init: () => Promise.reject(new Error('not available here')) };
