/** Shared configuration for the fizzwallet.com web pages. */

/**
 * Chrome extension id of the Fizz wallet. The pages message the extension via
 * chrome.runtime.sendMessage(EXTENSION_ID, …) — a token draft on /launch, a
 * bridge request on /bridge — and the extension's manifest
 * `externally_connectable` allows fizzwallet.com. If the published Web Store id
 * ever differs from this dev id, update it here — this is the ONLY place it lives.
 */
export const EXTENSION_ID = "bapbaajfnjockbcdhjpgpllflnhgogol";

// Per-network Aztec node URLs + L1 chains/RPCs live in ./networks.ts — the
// bridge toggles between mainnet and testnet.

/** Where to acquire the AZTEC token (the L1 fee asset you bridge into fee juice). */
export const AZTEC_TOKEN_URL = "https://aztec.network/token";

export const GITHUB_URL = "https://github.com/rolldavid/fizz";

/** Placeholder until the Web Store listing is live; the id is already final. */
export const CHROME_STORE_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}`;
