/**
 * Background service worker.
 *
 * Kept intentionally tiny. The PXE + proving runs inside the popup (an extension
 * page), because:
 *   - MV3 service workers get killed aggressively (~30s idle), which would tear
 *     down PXE mid-tx.
 *   - SharedArrayBuffer / WASM-threads work in extension pages with the COOP/COEP
 *     headers we set in the manifest, but the SW environment has different
 *     constraints.
 *
 * If we add dApp-injection later (a content-script provider that asks the wallet
 * to sign on behalf of a website), this worker becomes the message broker: it
 * receives requests from content scripts and opens a popup window to confirm.
 */

chrome.runtime.onInstalled.addListener(() => {
    // Reserved for future setup (badge text, default action icon, etc.).
});
