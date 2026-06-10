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
import {
    isConnected,
    removeConnection,
    savePendingConnect,
} from "../lib/state/connections";
import {
    clearBridgeDeposit,
    clearBridgeParams,
    readBridgeParams,
    saveBridgeDeposit,
    savePrepare,
} from "../lib/state/bridgeHandoff";

/** Minimum gap between wallet windows — anti-spam for connect / launch. */
const LAUNCH_WINDOW_COOLDOWN_MS = 8000;

chrome.runtime.onInstalled.addListener(() => {
    // Reserved for future setup (badge text, default action icon, etc.).
});

// fizzwallet.com/launch is the ONLY external caller. The handshake:
//   1. "fizz:ping"              — detect the extension is installed.
//   2. "fizz:connect"           — open the wallet's #connect window so the USER
//                                 approves this origin (address-blind: the page
//                                 never learns who they are).
//   3. "fizz:connection-status" — poll whether this origin is connected.
//   4. "fizz:launch-token"      — hand over a token draft (REQUIRES a live
//                                 connection); the wallet opens its own window
//                                 where the USER reviews and deploys.
//   5. "fizz:launch-status"     — poll for the public result (address + tx).
//   6. "fizz:disconnect"        — drop this origin's connection.
// None of these carry secrets, none reveal the user's address, and nothing
// deploys without an explicit in-wallet confirmation.
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
    // Local web-app development talks to an unpacked build. Stripped from
    // production builds so a published wallet never trusts a localhost page.
    ...(import.meta.env.PROD ? [] : ["http://localhost"]),
]);

/**
 * Per-action cooldown for opening wallet windows. Returns true if a window was
 * opened under `key` within LAUNCH_WINDOW_COOLDOWN_MS (i.e. the caller should
 * refuse); otherwise stamps `now` and returns false. Stored in storage.session
 * so it survives service-worker restarts within a browser session.
 */
async function openWindowRateLimited(key: string): Promise<boolean> {
    const now = Date.now();
    const got = await chrome.storage.session.get(key);
    const last = typeof got?.[key] === "number" ? got[key] : 0;
    if (now - last < LAUNCH_WINDOW_COOLDOWN_MS) return true;
    await chrome.storage.session.set({ [key]: now });
    return false;
}

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
                case "fizz:connection-status": {
                    sendResponse({ ok: true, connected: await isConnected(origin) });
                    return;
                }
                case "fizz:connect": {
                    // Rate-limit connect windows the same way as launch windows.
                    if (await openWindowRateLimited("fizz.lastConnectWindowAt")) {
                        sendResponse({
                            ok: false,
                            error: "A Fizz window was just opened — finish or close it first.",
                        });
                        return;
                    }
                    await savePendingConnect(origin);
                    await chrome.windows.create({
                        url: chrome.runtime.getURL("src/popup/index.html#connect"),
                        type: "popup",
                        width: 420,
                        height: 820,
                    });
                    sendResponse({ ok: true });
                    return;
                }
                case "fizz:disconnect": {
                    await removeConnection(origin);
                    sendResponse({ ok: true });
                    return;
                }
                case "fizz:launch-token": {
                    // The origin must have an approved, live connection — an
                    // un-connected (or revoked) site can't open launch windows.
                    if (!(await isConnected(origin))) {
                        sendResponse({ ok: false, error: "Connect your Fizz wallet first." });
                        return;
                    }
                    // Rate-limit: one launch window per LAUNCH_WINDOW_COOLDOWN_MS
                    // so a hostile/XSS'd allowed origin can't spam wallet popups.
                    if (await openWindowRateLimited("fizz.lastLaunchWindowAt")) {
                        sendResponse({
                            ok: false,
                            error: "A Fizz launch window was just opened — finish or close it first.",
                        });
                        return;
                    }
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
                case "fizz:bridge-prepare": {
                    // Auto-send fee juice to the connected account. Requires a
                    // live connection; opens the wallet, which (unlocked)
                    // generates the claim secret + recipient. No address or
                    // secret crosses here — only a "please prepare" signal.
                    if (!(await isConnected(origin))) {
                        sendResponse({ ok: false, error: "Connect your Fizz wallet first." });
                        return;
                    }
                    // The amount is the wei value the page will deposit (decimal
                    // digits only). The popup re-derives everything else; the
                    // claim amount is re-verified from the on-chain event anyway.
                    const amount = typeof message.amount === "string" ? message.amount : "";
                    if (!/^[0-9]{1,40}$/.test(amount) || amount === "0") {
                        sendResponse({ ok: false, error: "Invalid bridge amount." });
                        return;
                    }
                    if (await openWindowRateLimited("fizz.lastBridgeWindowAt")) {
                        sendResponse({
                            ok: false,
                            error: "A Fizz window was just opened — finish or close it first.",
                        });
                        return;
                    }
                    // Clear any stale params/deposit from an abandoned earlier
                    // flow so the page can't poll and deposit against a previous
                    // secretHash (cross-flow contamination).
                    await clearBridgeParams();
                    await clearBridgeDeposit();
                    await savePrepare(origin, amount);
                    await chrome.windows.create({
                        url: chrome.runtime.getURL("src/popup/index.html#bridge"),
                        type: "popup",
                        width: 420,
                        height: 820,
                    });
                    sendResponse({ ok: true });
                    return;
                }
                case "fizz:bridge-params": {
                    // The page polls for the {recipient, secretHash} the popup
                    // produced (both public). Relayed, never persisted by us.
                    if (!(await isConnected(origin))) {
                        sendResponse({ ok: false, error: "Connect your Fizz wallet first." });
                        return;
                    }
                    const params = await readBridgeParams();
                    sendResponse({
                        ok: true,
                        params: params ? { recipient: params.recipient, secretHash: params.secretHash } : null,
                    });
                    return;
                }
                case "fizz:bridge-deposited": {
                    // The page reports its L1 deposit landed. We stash only the
                    // (public) secretHash + tx hash for the popup to verify on
                    // L1 and complete; a bogus report never verifies.
                    if (!(await isConnected(origin))) {
                        sendResponse({ ok: false, error: "Connect your Fizz wallet first." });
                        return;
                    }
                    const secretHash = typeof message.secretHash === "string" ? message.secretHash : "";
                    const l1TxHash = typeof message.l1TxHash === "string" ? message.l1TxHash : "";
                    if (!/^0x[0-9a-fA-F]{64}$/.test(secretHash) || !/^0x[0-9a-fA-F]{64}$/.test(l1TxHash)) {
                        sendResponse({ ok: false, error: "Malformed deposit report." });
                        return;
                    }
                    await saveBridgeDeposit(secretHash, l1TxHash);
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
