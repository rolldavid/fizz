/** Shared configuration for the fizzwallet.com web pages. */

/**
 * Chrome extension id of the Fizz wallet. The pages hand claim tickets and
 * token drafts to the extension via chrome.runtime.sendMessage(EXTENSION_ID, …)
 * (the extension's manifest `externally_connectable` allows fizzwallet.com).
 * If the published Web Store id ever differs from this dev id, update it here —
 * this is the ONLY place it lives.
 */
export const EXTENSION_ID = "bapbaajfnjockbcdhjpgpllflnhgogol";

/**
 * Canonical Aztec ALPHA (mainnet) node — l1ContractAddresses are fetched LIVE
 * from it and checked against the pin in nodeInfo.ts. The bridge is mainnet-only
 * (Aztec mainnet has no faucet/sponsored FPC; you bridge the AZTEC token).
 */
export const AZTEC_NODE_URL = "https://aztec-mainnet.drpc.org";

/** Friendly network id stamped into claim tickets (must match the wallet's "alpha"). */
export const AZTEC_NETWORK_ID = "alpha";

/** Ethereum MAINNET L1 RPC used for reads/receipts (the L1 side of the bridge). */
export const L1_RPC_URL = "https://ethereum-rpc.publicnode.com";

/** Where to acquire the AZTEC token (the L1 fee asset you bridge into fee juice). */
export const AZTEC_TOKEN_URL = "https://aztec.network/token";

/**
 * WalletConnect Cloud project id, from the build environment only (no value in
 * source). Set VITE_WALLETCONNECT_PROJECT_ID at build time. Without it, injected
 * wallets (MetaMask, Rabby, …) still connect; only the WalletConnect QR option
 * is unavailable. The id is a public client identifier, so it's safe to expose
 * in the built bundle — keeping it out of source just avoids committing it.
 */
export const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "";

export const GITHUB_URL = "https://github.com/rolldavid/fizz";

/** Placeholder until the Web Store listing is live; the id is already final. */
export const CHROME_STORE_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}`;
