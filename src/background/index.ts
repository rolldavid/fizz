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

import { decodeClaimTicket } from "../lib/aztec/claimTicket";
import { appendToClaimInbox } from "../lib/aztec/claimInbox";
import {
    readConnectGrant,
    readLastLaunch,
    recordConnectRequest,
    saveDeployDraft,
    type DeployDraft,
} from "../lib/state/opJournal";

chrome.runtime.onInstalled.addListener(() => {
    // Reserved for future setup (badge text, default action icon, etc.).
});

// fizzwallet.com pages talk to the wallet over external messaging:
//   /bridge → "fizz:claim-ticket"  hands over a finished fee-juice deposit so
//             the next transaction auto-pays with it.
//   /launch → "fizz:launch-token"  hands over a token draft; the wallet opens
//             its own window where the USER reviews and deploys (the page
//             never sees keys or even the user's address), then polls
//             "fizz:launch-status" for the public result.
// Origins are restricted twice: by manifest `externally_connectable.matches`
// AND the explicit check here. The SW can't use the encrypted store (the meta
// key lives in the unlocked popup), so claim tickets land in a plaintext
// inbox the popup drains at unlock / Bridge refresh — see claimInbox.ts.
const ALLOWED_ORIGINS = new Set([
    "https://fizzwallet.com",
    "https://www.fizzwallet.com",
    "https://fizzwallet.netlify.app",
    "http://localhost", // local web-app development (any port)
]);

function sanitizeDraft(raw: any): DeployDraft {
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
    // Light bounds only — the Deploy page and deployToken re-validate strictly
    // (the user always reviews this draft in the wallet before anything runs).
    return {
        name: str(raw?.name, 30),
        symbol: str(raw?.symbol, 8).toUpperCase(),
        decimals: str(raw?.decimals, 2) || "18",
        supply: str(raw?.supply, 30),
        supplyMode: raw?.supplyMode === "public" ? "public" : "private",
        keepMinter: raw?.keepMinter !== false,
    };
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    void (async () => {
        try {
            const origin = sender.origin ?? new URL(sender.url ?? "").origin;
            const originNoPort = origin.replace(/:\d+$/, "");
            if (!ALLOWED_ORIGINS.has(origin) && !ALLOWED_ORIGINS.has(originNoPort)) {
                throw new Error(`Origin not allowed: ${origin}`);
            }
            switch (message?.type) {
                case "fizz:ping": {
                    sendResponse({ ok: true, wallet: "fizz" });
                    return;
                }
                case "fizz:claim-ticket": {
                    if (typeof message.ticket !== "string") throw new Error("Missing ticket.");
                    await appendToClaimInbox(decodeClaimTicket(message.ticket));
                    sendResponse({ ok: true });
                    return;
                }
                case "fizz:launch-token": {
                    await saveDeployDraft(sanitizeDraft(message.draft));
                    await chrome.windows.create({
                        url: chrome.runtime.getURL("src/popup/index.html#deploy"),
                        type: "popup",
                        width: 420,
                        height: 820,
                    });
                    sendResponse({ ok: true });
                    return;
                }
                case "fizz:launch-status": {
                    sendResponse({ ok: true, result: await readLastLaunch() });
                    return;
                }
                case "fizz:connect": {
                    // The page wants the active account address (deposit
                    // recipient). Decided by the USER in the approval window —
                    // the SW knows nothing (vault-locked).
                    await recordConnectRequest({ origin, at: Date.now() });
                    await chrome.windows.create({
                        url: chrome.runtime.getURL("src/popup/index.html#connect"),
                        type: "popup",
                        width: 420,
                        height: 560,
                    });
                    sendResponse({ ok: true, pending: true });
                    return;
                }
                case "fizz:connect-status": {
                    const grant = await readConnectGrant();
                    // Strict origin binding: a grant approved for one origin is
                    // never served to another.
                    if (!grant || (grant.origin !== origin && grant.origin !== originNoPort)) {
                        sendResponse({ ok: true, granted: false });
                        return;
                    }
                    if (grant.denied) {
                        sendResponse({ ok: true, granted: false, denied: true });
                        return;
                    }
                    sendResponse({
                        ok: true,
                        granted: true,
                        address: grant.address,
                        networkId: grant.networkId,
                    });
                    return;
                }
                default:
                    throw new Error("Unknown message.");
            }
        } catch (err) {
            sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
    })();
    return true; // keep the message channel open for the async response
});
