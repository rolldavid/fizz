/** Shared configuration for the fizzwallet.com web pages. */

/**
 * Chrome extension id of the Fizz wallet. The pages hand claim tickets and
 * token drafts to the extension via chrome.runtime.sendMessage(EXTENSION_ID, …)
 * (the extension's manifest `externally_connectable` allows fizzwallet.com).
 * If the published Web Store id ever differs from this dev id, update it here —
 * this is the ONLY place it lives.
 */
export const EXTENSION_ID = "bapbaajfnjockbcdhjpgpllflnhgogol";

/** Canonical Aztec testnet node — l1ContractAddresses are fetched LIVE from it. */
export const AZTEC_NODE_URL = "https://rpc.testnet.aztec-labs.com";

/** Friendly network id stamped into claim tickets (must match the wallet's). */
export const AZTEC_NETWORK_ID = "testnet";

/** Sepolia RPC used for reads/receipts — same endpoint the extension uses. */
export const SEPOLIA_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";

/**
 * WalletConnect Cloud project id.
 *
 * "FIZZ_WC_PROJECT_ID" is a PLACEHOLDER: injected wallets (MetaMask, Rabby, …)
 * connect fine without a real id, but the WalletConnect QR option will not.
 * Site owner: create a free project at https://cloud.walletconnect.com and
 * build with `VITE_WALLETCONNECT_PROJECT_ID=<id> yarn build` (see web/README.md).
 */
export const WALLETCONNECT_PROJECT_ID =
    import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "FIZZ_WC_PROJECT_ID";

export const GITHUB_URL = "https://github.com/rolldavid/fizz";

/** Placeholder until the Web Store listing is live; the id is already final. */
export const CHROME_STORE_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}`;
