/** Shared configuration for the fizzwallet.com web pages. */

/**
 * Chrome extension id of the Fizz wallet — the PUBLISHED Web Store id. The
 * pages message the extension via chrome.runtime.sendMessage(EXTENSION_ID, …)
 * — the fee-juice bridge hand-off on /bridge — and the extension's manifest
 * `externally_connectable` allows fizzwallet.com. This is the ONLY place it
 * lives. It must always match the `key` pinned in src/manifest.ts (the store's
 * public key), or the site and the wallet stop hearing each other.
 */
export const EXTENSION_ID = "kadklgafmpoomnhnbjkeajapglmmegfj";

// Per-network Aztec node URLs + L1 chains/RPCs live in ./networks.ts — the
// bridge toggles between mainnet and testnet.

/** Where to acquire the AZTEC token (the L1 fee asset you bridge into fee juice). */
export const AZTEC_TOKEN_URL = "https://aztec.network/token";

export const GITHUB_URL = "https://github.com/rolldavid/fizz";

export const CHROME_STORE_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}`;
