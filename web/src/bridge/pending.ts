/**
 * Fund-safety ledger in localStorage.
 *
 * The claim secret is persisted BEFORE any L1 transaction is broadcast: if the
 * tab dies mid-flow, nothing redeemable is ever lost — the page re-offers the
 * ticket (or at least the secret) on the next visit. Mirrors the lifecycle the
 * extension uses in src/lib/aztec/bridge.ts, reduced to what a stateless page
 * needs.
 */

export type PendingRecord = {
    id: string;
    networkId: string;
    l1ChainId: number;
    recipient: string;
    /** bigint as decimal string */
    amount: string;
    claimSecret: `0x${string}`;
    claimSecretHash: `0x${string}`;
    /** "created" = secret saved, deposit not confirmed; "deposited" = ticket-complete. */
    status: "created" | "deposited";
    l1TxHash?: `0x${string}`;
    messageHash?: `0x${string}`;
    /** bigint as decimal string */
    messageLeafIndex?: string;
    createdAt: number;
};

const KEY = "fizz.bridge.pending.v1";
/** Drop records older than this so the ledger (recipient + secret + tx) doesn't
 *  accumulate a deanonymizing history on a shared machine. */
const RECORD_TTL_MS = 14 * 24 * 60 * 60_000; // 14 days
/** Hard cap on retained records so a runaway/garbage ledger can't grow unbounded. */
const MAX_RECORDS = 100;

const HEX = /^0x[0-9a-fA-F]{1,200}$/;
const DECIMAL = /^\d{1,78}$/;

/** A record must be structurally sound, or it's dropped (never render-thrown). */
function isValidRecord(r: unknown): r is PendingRecord {
    const x = r as Record<string, unknown>;
    if (!x || typeof x !== "object") return false;
    if (typeof x.id !== "string" || typeof x.networkId !== "string") return false;
    if (typeof x.l1ChainId !== "number") return false;
    if (typeof x.recipient !== "string" || !HEX.test(x.recipient)) return false;
    if (typeof x.amount !== "string" || !DECIMAL.test(x.amount)) return false;
    if (typeof x.claimSecret !== "string" || !HEX.test(x.claimSecret)) return false;
    if (x.status !== "created" && x.status !== "deposited") return false;
    if (typeof x.createdAt !== "number") return false;
    // Optional fields, when present, must be well-formed.
    if (x.l1TxHash !== undefined && (typeof x.l1TxHash !== "string" || !HEX.test(x.l1TxHash))) return false;
    if (x.messageHash !== undefined && (typeof x.messageHash !== "string" || !HEX.test(x.messageHash))) return false;
    if (x.messageLeafIndex !== undefined && (typeof x.messageLeafIndex !== "string" || !DECIMAL.test(x.messageLeafIndex)))
        return false;
    // A "deposited" record must be ticket-complete, so ticketFromRecord can
    // never throw while rendering the saved-bridges list.
    if (x.status === "deposited" && (!x.l1TxHash || !x.messageHash || !x.messageLeafIndex)) return false;
    return true;
}

function readAll(): PendingRecord[] {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // Unparseable ledger: drop it rather than throw on every render.
        localStorage.removeItem(KEY);
        return [];
    }
    if (!Array.isArray(parsed)) {
        localStorage.removeItem(KEY);
        return [];
    }
    // Skip malformed records (a single bad one must never white-screen the page)
    // and expire old ones.
    const cutoff = Date.now() - RECORD_TTL_MS;
    return parsed.filter((r) => isValidRecord(r) && (r as PendingRecord).createdAt >= cutoff) as PendingRecord[];
}

function writeAll(records: PendingRecord[]): void {
    localStorage.setItem(KEY, JSON.stringify(records.slice(0, MAX_RECORDS)));
}

export function listRecords(): PendingRecord[] {
    return readAll();
}

/** Wipe the local ledger (privacy: clears recipient/secret/tx history). */
export function clearRecords(): void {
    localStorage.removeItem(KEY);
}

export function createRecord(
    fields: Omit<PendingRecord, "id" | "status" | "createdAt">,
): PendingRecord {
    const record: PendingRecord = {
        ...fields,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: "created",
        createdAt: Date.now(),
    };
    writeAll([record, ...readAll()]);
    return record;
}

export function updateRecord(id: string, patch: Partial<PendingRecord>): PendingRecord {
    const all = readAll();
    const idx = all.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Bridge record ${id} not found in localStorage.`);
    const next = { ...all[idx], ...patch } as PendingRecord;
    all[idx] = next;
    writeAll(all);
    return next;
}

export function removeRecord(id: string): void {
    writeAll(readAll().filter((r) => r.id !== id));
}
