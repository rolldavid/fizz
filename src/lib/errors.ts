/**
 * Human-readable error text.
 *
 * CRITICAL: a `DOMException` — thrown by IndexedDB / the in-browser PXE store,
 * WebCrypto, fetch AbortController, OPFS, etc. — is NOT an `instanceof Error`.
 * The common `e instanceof Error ? e.message : String(e)` pattern therefore
 * stringifies it to the useless "[object DOMException]", which hides the real
 * fault (QuotaExceededError, "database connection is closing", AbortError, …).
 * When a send fails on a PXE/storage fault that means the user — and us — see
 * nothing actionable. Always route error text through this.
 */

/**
 * Redact an address-shaped value for logs/UI — never print a full account or
 * recipient address (this is a security-audited, privacy-first wallet). Single
 * canonical definition; the per-module copies import this (PRIVACY-02).
 */
export function redact(a: string): string {
    return a.length > 12 ? `${a.slice(0, 10)}…` : a;
}

/**
 * Scrub address-shaped substrings out of arbitrary error text (PRIVACY-01/03/35).
 * Raw SDK / node error strings frequently embed a full Aztec address (0x + 64
 * hex), an Ethereum address (0x + 40 hex), or a tx hash (0x + 64 hex). Those must
 * never reach a console log, a UI surface, or — worst — a dapp response. We
 * collapse each to a short prefix. Where the wallet INTENTIONALLY shows a hash
 * (e.g. the post-broadcast "verify in Activity" message) it is constructed as a
 * hardcoded slice OUTSIDE this path, so scrubbing here is always safe.
 */
export function scrubAddresses(s: string): string {
    return s
        .replace(/0x[0-9a-fA-F]{64}/g, (m) => `${m.slice(0, 10)}…⟨addr⟩`)
        .replace(/0x[0-9a-fA-F]{40}/g, (m) => `${m.slice(0, 10)}…⟨addr⟩`);
}

export function describeError(err: unknown): string {
    let raw: string;
    if (err instanceof DOMException) {
        raw = err.message ? `${err.name}: ${err.message}` : err.name;
    } else if (err instanceof Error) {
        raw = err.message || err.name || "Error";
    } else if (err && typeof err === "object") {
        const msg = (err as { message?: unknown }).message;
        if (typeof msg === "string" && msg) {
            raw = msg;
        } else {
            try {
                raw = JSON.stringify(err);
            } catch {
                raw = String(err);
            }
        }
    } else {
        raw = String(err);
    }
    // Scrub at the single chokepoint so EVERY caller (contacts, tx-history, UI,
    // the dapp response path) inherits address redaction for free.
    return scrubAddresses(raw);
}

/**
 * Thrown when a transaction was already BROADCAST (`send()` returned a tx hash)
 * but the post-broadcast local bookkeeping (`markFeeConsumed`, a storage write,
 * or a lock teardown) then failed (ERRORS-22). The tx may well have landed, so
 * the caller must NOT treat this as a plain "send failed" / "retry" — that risks
 * a double-send. `humanizeTxError` routes it to a "verify in Activity" message
 * that carries the captured hash.
 */
export class PostBroadcastBookkeepingError extends Error {
    readonly txHash: string;
    constructor(txHash: string, cause?: unknown) {
        super(`Transaction ${txHash.slice(0, 12)}… broadcast but post-send bookkeeping failed`);
        this.name = "PostBroadcastBookkeepingError";
        this.txHash = txHash;
        if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
    }
}

/**
 * Map a raw send/tx error to actionable user-facing text. Buckets are ordered by
 * SAFETY — the most dangerous-to-misclassify cases come first:
 *
 *  0. PostBroadcastBookkeepingError — the tx WAS broadcast; never say "retry".
 *  1. Wallet locked mid-send — the lock may have torn down after broadcast;
 *     steer to verify, not blind retry (ERRORS-27).
 *  2. Post-broadcast receipt failure (`node_getTxReceipt`) — broadcast, landing
 *     unknown; verify before resending (double-send safety).
 *  3. Pre-broadcast sync drift ("Block header not found", reorg, "Unknown
 *     block") — the tx never left the device; safe to retry, clears on its own.
 *
 * Everything else passes through describeError unchanged.
 */
export function humanizeTxError(err: unknown): string {
    // Bucket 0 — structured signal that the tx is already on the wire.
    if (err instanceof PostBroadcastBookkeepingError) {
        return (
            `Transaction submitted (${err.txHash.slice(0, 12)}…) but the wallet couldn't finish ` +
            "recording it. Check your transaction history (or Aztec Scan) before sending it " +
            "again — it may have already gone through."
        );
    }
    const raw = describeError(err);
    // Bucket 1 — wallet locked while a tx was in flight.
    if (/encrypted storage unavailable|wallet is locked|wallet locked/i.test(raw)) {
        return (
            "The wallet locked while processing your transaction. Unlock and check your " +
            "transaction history to see if it went through before retrying."
        );
    }
    // Bucket 2 — post-broadcast receipt failure: never blindly retry a possibly-landed tx.
    if (/node_gettxreceipt|get ?tx ?receipt/i.test(raw)) {
        return (
            "Your transaction was submitted, but the node couldn't confirm whether it landed. " +
            "Check your transaction history (or Aztec Scan) before sending it again — it may " +
            "have already gone through."
        );
    }
    // Bucket 3 — pre-broadcast sync drift, safe to retry.
    if (
        /block header not found|not found when querying world state|reorg|unknown block|node_getblocks|node_getcheckpointedblocks/i.test(
            raw,
        )
    ) {
        return (
            "The network was briefly out of sync (the node hadn't caught up to your wallet's " +
            "synced state). This clears on its own — wait about a minute and try again."
        );
    }
    return raw;
}
