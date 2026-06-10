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

export type ConnectionStatus = { installed: boolean; connected: boolean };

/**
 * Whether Fizz is installed and whether THIS origin is currently connected.
 * `installed:false` is a normal state (install CTA), so a failed round-trip is
 * reported as "not installed", not thrown.
 *
 * Address-blind: the wallet returns only a boolean. It never reveals the user's
 * address, account, or balances over this channel.
 */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
    if (!fizzMessagingAvailable()) return { installed: false, connected: false };
    try {
        const res = await sendToFizz<FizzOk & { connected?: boolean }>(
            { type: "fizz:connection-status" },
            2500,
        );
        return { installed: true, connected: res.connected === true };
    } catch {
        return { installed: false, connected: false };
    }
}

/**
 * Ask the wallet to open its approval window for this origin. Resolves once the
 * window has been opened — the actual approval is the user's, observed by
 * polling getConnectionStatus afterwards. Throws if Fizz refuses (e.g. a window
 * is already open).
 */
export async function connectFizz(): Promise<void> {
    const res = await sendToFizz<{ ok: boolean; error?: string }>({ type: "fizz:connect" });
    if (!res.ok) throw new Error(res.error ?? "Fizz refused the connection request.");
}

/** Revoke this origin's connection. Throws if the wallet reports a failure. */
export async function disconnectFizz(): Promise<void> {
    const res = await sendToFizz<{ ok: boolean; error?: string }>({ type: "fizz:disconnect" });
    if (!res.ok) throw new Error(res.error ?? "Fizz could not disconnect.");
}

// ── Auto-send bridge handshake ───────────────────────────────────────────────
// The wallet generates the claim secret + recipient; this page only does the L1
// deposit and reports its tx hash. The secret never crosses this channel.

/** Ask Fizz to open its prepare window for a deposit of `amountWei` (decimal string). */
export async function prepareBridge(amountWei: string): Promise<void> {
    const res = await sendToFizz<{ ok: boolean; error?: string }>({
        type: "fizz:bridge-prepare",
        amount: amountWei,
    });
    if (!res.ok) throw new Error(res.error ?? "Fizz refused the bridge request.");
}

/** Poll for the {recipient, secretHash} the wallet produced once the user approves. */
export async function getBridgeParams(): Promise<{ recipient: string; secretHash: string } | null> {
    const res = await sendToFizz<{
        ok: boolean;
        params?: { recipient: string; secretHash: string } | null;
    }>({ type: "fizz:bridge-params" });
    return res.ok && res.params ? res.params : null;
}

/** Report the L1 deposit tx so the wallet can verify it on-chain and complete the claim. */
export async function notifyBridgeDeposited(secretHash: string, l1TxHash: string): Promise<void> {
    const res = await sendToFizz<{ ok: boolean; error?: string }>({
        type: "fizz:bridge-deposited",
        secretHash,
        l1TxHash,
    });
    if (!res.ok) throw new Error(res.error ?? "Fizz did not record the deposit.");
}
