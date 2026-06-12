/**
 * Serializes high-level PXE operations against the in-browser IndexedDB store.
 *
 * WHY: the PXE's kv-store (@aztec/kv-store/indexeddb) binds an IndexedDB
 * objectStore to a transaction for that transaction's lifetime, and IndexedDB
 * auto-commits a transaction the instant the event loop yields with no pending
 * request. Several store operations `await` between an index read and a write
 * (e.g. SenderAddressBookStore.addSender does `hasAsync` then `set`). Under
 * concurrent PXE activity, unrelated microtasks interleave in that gap, the
 * transaction commits early, and the next access throws
 * `InvalidStateError: ... The transaction has finished` — which aborts sends and
 * sender registration. The SDK serializes a single transaction but NOT the
 * multi-step operations WE orchestrate (fee estimate, send, deploy, auto-claim,
 * boot sync), so two of those interleaving is what opens the window.
 *
 * This lock runs those operations one at a time, end to end, so no two ever
 * interleave their awaits. It also marks the op active (via {@link trackOp}) so
 * the idle auto-lock and the background auto-claim tick both defer while a PXE
 * operation is in flight.
 *
 * RULE: acquire ONLY at an outermost entry point — never inside a shared helper
 * (listReadyClaims, resolveFeePaymentMethod, registerSender) that a
 * lock-holding operation already calls, or callers would deadlock. The wrapped
 * entry points are mutually non-nesting: a send execute never calls an estimate
 * and vice-versa, and the auto-claim tick is NOT wrapped (it calls a locked
 * deploy to resume an interrupted deployment).
 */
import { trackOp } from "../state/activity";

let tail: Promise<unknown> = Promise.resolve();

/** Run `fn` after every previously-queued PXE operation has fully settled. */
export function withPxeLock<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the tail regardless of whether the prior op resolved or threw,
    // so one failure never wedges the queue. trackOp bumps the activity counter
    // only once it's actually our turn (not while we wait).
    const run = tail.then(
        () => trackOp(fn),
        () => trackOp(fn),
    );
    tail = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}
