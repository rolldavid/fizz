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
 * Map a raw send/tx error to actionable user-facing text.
 *
 * Two distinct buckets, and the distinction is a SAFETY one:
 *
 *  1. Pre-broadcast sync drift — "Block header not found", world-state
 *     not-found, reorg, "Unknown block" from node_getBlocks /
 *     node_getCheckpointedBlocks. The tx never left the device; the PXE's synced
 *     tip was briefly out of step with the node (load-balancer height skew, or a
 *     node still catching up). Safe to just retry; it clears on its own.
 *
 *  2. Post-broadcast receipt failure — node_getTxReceipt. By the time the
 *     receipt is fetched the tx HAS been broadcast, so it may already have
 *     landed. Telling the user to "just try again" here risks a DOUBLE-SEND, so
 *     we steer them to verify first instead.
 *
 * Everything else passes through describeError unchanged.
 */
export function humanizeTxError(err: unknown): string {
    const raw = describeError(err);
    // Bucket 2 first — never tell the user to blindly retry a possibly-landed tx.
    if (/node_gettxreceipt|get ?tx ?receipt/i.test(raw)) {
        return (
            "Your transaction was submitted, but the node couldn't confirm whether it landed. " +
            "Check your transaction history (or Aztec Scan) before sending it again — it may " +
            "have already gone through."
        );
    }
    // Bucket 1 — pre-broadcast sync drift, safe to retry.
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
