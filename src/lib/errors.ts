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
