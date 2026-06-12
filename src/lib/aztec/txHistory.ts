/**
 * Local, on-device transaction history.
 *
 * SCOPE: per account + per network, NEVER synced across devices. The list is a
 * convenience ledger reconstructed from what THIS wallet did (outgoing sends) +
 * what it can observe (incoming Transfer events) + dapp authorizations. It is
 * NOT a source of truth — the chain is. Nothing here gates spending or balance.
 *
 * BEST-EFFORT BY DESIGN (the sanctioned exception to the no-fallback rule):
 * recording history must never throw into a send or the UI, and reading it for a
 * read-only view must never throw either. A history write that fails just means
 * one row is missing from a convenience screen — losing that is strictly better
 * than aborting a successful transaction or white-screening the activity page.
 * So every function here swallows its own errors, warns via describeError, and
 * (for reads) returns an empty list rather than a masking default that a caller
 * could mistake for real data. Addresses are NEVER logged (this is a security-
 * audited wallet); see `redact`.
 *
 * Stored encrypted-at-rest (secureGet/secureSet): amounts and counterparties are
 * sensitive. Requires the wallet unlocked, which it always is when sending or
 * viewing history.
 */

import { KEYS } from "../storage";
import { secureGet, secureSet } from "../secureStorage";
import { describeError } from "../errors";

/** Redact an address for logs — never print a full account/recipient address. */
const redact = (a: string): string => (a.length > 12 ? `${a.slice(0, 10)}…` : a);

export type TxHistoryEntry = {
    /** txHash for txns; `auth:${origin}:${at}` for auth; `${txHash}:${logIndex}` for incoming. */
    id: string;
    kind: "transfer" | "shield" | "unshield" | "mint" | "deploy" | "authorization";
    direction?: "in" | "out" | "self";
    privacy?: "public" | "private";
    txHash?: string;
    tokenAddress?: string;
    amount?: string; // bigint as string
    counterparty?: string; // recipient (out) or sender (in), as 0x string
    feeJuice?: string; // bigint as string
    at: number; // Date.now()
    origin?: string; // for authorization
    authAction?: "approved" | "revoked";
    /** Free-form label, e.g. the token symbol for a deploy. */
    label?: string;
};

/** Most recent N kept per list — older entries are dropped (a local view, not an archive). */
const MAX_ACCOUNT_ENTRIES = 500;
const MAX_AUTH_ENTRIES = 200;

function accountKey(networkId: string, account: string): string {
    return `${KEYS.txHistoryPrefix}.${networkId}.${account}`;
}
function authKey(): string {
    return `${KEYS.txHistoryPrefix}.auth`;
}
function cursorKey(networkId: string, account: string): string {
    return `${KEYS.txHistoryPrefix}.${networkId}.${account}.cursor`;
}

async function readList(key: string): Promise<TxHistoryEntry[]> {
    const stored = await secureGet<TxHistoryEntry[]>(key);
    return Array.isArray(stored) ? stored : [];
}

/**
 * Append one entry to the per-account list, newest-first, deduped by `id` and
 * capped. Best-effort: a failure here must never throw into a send (see header).
 */
export async function recordEntry(
    networkId: string,
    account: string,
    entry: TxHistoryEntry,
): Promise<void> {
    try {
        const key = accountKey(networkId, account);
        const list = await readList(key);
        if (list.some((e) => e.id === entry.id)) return; // already recorded
        const next = [entry, ...list].slice(0, MAX_ACCOUNT_ENTRIES);
        await secureSet(key, next);
    } catch (err) {
        // Best-effort: recording is non-load-bearing convenience — never let a
        // history write break the send/flow that produced it.
        console.warn(`tx-history: recordEntry failed for ${redact(account)}`, describeError(err));
    }
}

/**
 * Append a dapp-authorization event to the wallet-wide (address-blind) auth log.
 * Best-effort: never throw into the connect/disconnect flow.
 */
export async function recordAuth(action: "approved" | "revoked", origin: string): Promise<void> {
    try {
        const key = authKey();
        const at = Date.now();
        const entry: TxHistoryEntry = {
            id: `auth:${origin}:${at}`,
            kind: "authorization",
            origin,
            authAction: action,
            at,
        };
        const list = await readList(key);
        const next = [entry, ...list].slice(0, MAX_AUTH_ENTRIES);
        await secureSet(key, next);
    } catch (err) {
        // Best-effort: the connection itself is already saved; the log row is
        // convenience only.
        console.warn("tx-history: recordAuth failed", describeError(err));
    }
}

/**
 * Merge the per-account list with the wallet-wide auth log, newest-first.
 * Best-effort: returns [] (with a warn) on a read failure — acceptable for a
 * read-only convenience view, and never a masking default a caller would trust.
 */
export async function listHistory(networkId: string, account: string): Promise<TxHistoryEntry[]> {
    try {
        const [own, auth] = await Promise.all([
            readList(accountKey(networkId, account)),
            readList(authKey()),
        ]);
        return [...own, ...auth].sort((a, b) => b.at - a.at);
    } catch (err) {
        // Best-effort read: a corrupt/locked store yields an empty view, not a
        // thrown error that white-screens the history page.
        console.warn(`tx-history: listHistory failed for ${redact(account)}`, describeError(err));
        return [];
    }
}

/** Last block the incoming scan reached for this account+network, or null if never run. */
export async function getScanCursor(networkId: string, account: string): Promise<number | null> {
    try {
        const v = await secureGet<number>(cursorKey(networkId, account));
        return typeof v === "number" ? v : null;
    } catch (err) {
        console.warn(`tx-history: getScanCursor failed for ${redact(account)}`, describeError(err));
        return null;
    }
}

export async function setScanCursor(networkId: string, account: string, block: number): Promise<void> {
    try {
        await secureSet(cursorKey(networkId, account), block);
    } catch (err) {
        console.warn(`tx-history: setScanCursor failed for ${redact(account)}`, describeError(err));
    }
}
