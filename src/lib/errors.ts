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
export function describeError(err: unknown): string {
    if (err instanceof DOMException) {
        return err.message ? `${err.name}: ${err.message}` : err.name;
    }
    if (err instanceof Error) {
        return err.message || err.name || "Error";
    }
    if (err && typeof err === "object") {
        const msg = (err as { message?: unknown }).message;
        if (typeof msg === "string" && msg) return msg;
        try {
            return JSON.stringify(err);
        } catch {
            return String(err);
        }
    }
    return String(err);
}

/**
 * Map a raw send/tx error to actionable user-facing text. The node rejects a tx
 * whose anchor block it can't find ("Block header not found" / world-state
 * not-found / reorg) when the PXE's synced tip is out of step with the node it
 * broadcasts to — load-balancer/reorg skew (transient: retry) or a stale local
 * sync store (persistent: reset network sync). Surface that instead of the raw
 * SDK string. Everything else passes through describeError unchanged.
 */
export function humanizeTxError(err: unknown): string {
    const raw = describeError(err);
    if (/block header not found|not found when querying world state|reorg/i.test(raw)) {
        return (
            "The network moved while preparing your transaction (the node's view is out of step " +
            "with your wallet's synced state). Wait a few seconds and try again — if it keeps " +
            "failing, use “Reset network sync” in the menu to re-sync from chain."
        );
    }
    return raw;
}
