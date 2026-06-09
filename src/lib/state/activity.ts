/**
 * In-flight critical-operation tracker.
 *
 * The idle auto-lock fires after 5 minutes without input events — but a
 * first-time token deploy (CRS download + client-side proving + L2 inclusion)
 * legitimately runs longer than that while the user just watches. Locking
 * mid-flight tears down the PXE and kills the transaction. Long user-initiated
 * operations register here; the idle timer defers while any are active.
 *
 * Deliberately NOT for background polling (balance refresh, claim polling) —
 * counting those would defeat the auto-lock entirely.
 */

let active = 0;

export function hasActiveOps(): boolean {
    return active > 0;
}

/** Run a user-initiated long operation, deferring the idle auto-lock until it settles. */
export async function trackOp<T>(fn: () => Promise<T>): Promise<T> {
    active++;
    try {
        return await fn();
    } finally {
        active--;
    }
}
