/**
 * Messaging with the Fizz extension from fizzwallet.com pages.
 *
 * Chrome only exposes `chrome.runtime.sendMessage` to a web page when an
 * installed extension lists the page's origin in `externally_connectable` —
 * so its mere presence is already a (weak) install signal; "fizz:ping" is the
 * real one. The pages NEVER receive keys or addresses through this channel.
 */

import { EXTENSION_ID } from "./config";

export type FizzOk = { ok: true };
export type FizzErr = { ok: false; error?: string };

/** Shape of the wallet's "fizz:launch-status" result (src/lib/state/opJournal.ts). */
export type LastLaunch = {
    address: string;
    txHash: string;
    name: string;
    symbol: string;
    at: number;
};

/** Reply to "fizz:connect" — pending:true means an approval window opened (src/background/index.ts). */
export type ConnectPending = { ok: boolean; pending?: boolean; error?: string };

/**
 * Reply to "fizz:connect-status" (src/background/index.ts):
 *   granted:true  → address + networkId of the account the USER approved.
 *   denied:true   → the user clicked Deny in the approval window.
 *   neither       → no decision yet; keep polling.
 */
export type ConnectStatus = {
    ok: boolean;
    granted?: boolean;
    denied?: boolean;
    address?: string;
    networkId?: string;
    error?: string;
};

export function fizzMessagingAvailable(): boolean {
    return (
        typeof chrome !== "undefined" &&
        !!chrome.runtime &&
        typeof chrome.runtime.sendMessage === "function"
    );
}

/**
 * One round-trip to the extension. Rejects on: messaging unavailable, no
 * listener (extension missing/disabled), timeout, or an empty response.
 * `{ok:false}` responses are NOT rejected — callers decide what a refusal means.
 */
export function sendToFizz<T extends { ok: boolean }>(
    message: Record<string, unknown>,
    timeoutMs = 4000,
): Promise<T> {
    if (!fizzMessagingAvailable()) {
        return Promise.reject(
            new Error("Extension messaging is unavailable — is Fizz installed in this browser?"),
        );
    }
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const timer = setTimeout(
            () => finish(() => reject(new Error("Fizz did not respond in time."))),
            timeoutMs,
        );
        try {
            chrome.runtime.sendMessage(EXTENSION_ID, message, (response: unknown) => {
                // Must read lastError inside the callback or Chrome logs an
                // "Unchecked runtime.lastError" — and we want the message anyway.
                const lastError = chrome.runtime.lastError;
                if (lastError) {
                    finish(() => reject(new Error(lastError.message ?? "Extension messaging failed.")));
                    return;
                }
                if (response === undefined || response === null) {
                    finish(() => reject(new Error("Fizz returned an empty response.")));
                    return;
                }
                finish(() => resolve(response as T));
            });
        } catch (err) {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
    });
}

/**
 * Presence probe. A boolean by design: "not installed" is a normal state this
 * page renders (install CTA), not an error to propagate.
 */
export async function pingFizz(): Promise<boolean> {
    if (!fizzMessagingAvailable()) return false;
    try {
        const res = await sendToFizz<FizzOk & { wallet?: string }>({ type: "fizz:ping" }, 2000);
        return res.ok === true && res.wallet === "fizz";
    } catch {
        return false;
    }
}
