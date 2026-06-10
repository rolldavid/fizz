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
 */

import { readLastLaunch, saveDeployDraft, type DeployDraft } from "../lib/state/opJournal";

/** Minimum gap between launch windows — anti-spam for fizz:launch-token. */
const LAUNCH_WINDOW_COOLDOWN_MS = 8000;

chrome.runtime.onInstalled.addListener(() => {
    // Reserved for future setup (badge text, default action icon, etc.).
});

// fizzwallet.com/launch is the ONLY external caller: it hands over a token
// draft ("fizz:launch-token"); the wallet opens its own window where the USER
// reviews and deploys (the page never sees keys or even the user's address),
// then polls "fizz:launch-status" for the public result. "fizz:ping" lets the
// page detect the extension. These three messages carry no secrets and trigger
// nothing the user doesn't explicitly confirm in-wallet.
//
// Fee-juice claims from /bridge are NOT delivered over this channel — the user
// copies the claim ticket and pastes it into the wallet (Need fee juice? →
// Import claim ticket). That keeps cross-origin pages from writing anything
// into wallet storage at all.
//
// Origins are restricted twice: by manifest `externally_connectable.matches`
// AND the explicit check here.
const ALLOWED_ORIGINS = new Set<string>([
    "https://fizzwallet.com",
    "https://www.fizzwallet.com",
    "https://fizzwallet.netlify.app",
    // Local web-app development talks to an unpacked build. Stripped from
    // production builds so a published wallet never trusts a localhost page.
    ...(import.meta.env.PROD ? [] : ["http://localhost"]),
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
                case "fizz:launch-token": {
                    // Rate-limit: one launch window per LAUNCH_WINDOW_COOLDOWN_MS
                    // so a hostile/XSS'd allowed origin can't spam wallet popups.
                    // Tracked in storage.session (survives SW restarts this run).
                    const KEY = "fizz.lastLaunchWindowAt";
                    const now = Date.now();
                    const got = await chrome.storage.session.get(KEY);
                    const last = typeof got?.[KEY] === "number" ? got[KEY] : 0;
                    if (now - last < LAUNCH_WINDOW_COOLDOWN_MS) {
                        sendResponse({
                            ok: false,
                            error: "A Fizz launch window was just opened — finish or close it first.",
                        });
                        return;
                    }
                    await chrome.storage.session.set({ [KEY]: now });
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
                default:
                    throw new Error("Unknown message.");
            }
        } catch (err) {
            sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
    })();
    return true; // keep the message channel open for the async response
});
