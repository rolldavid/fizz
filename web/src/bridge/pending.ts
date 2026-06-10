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

function readAll(): PendingRecord[] {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error(`Corrupted bridge ledger in localStorage (key ${KEY}) — expected an array.`);
    }
    return parsed as PendingRecord[];
}

function writeAll(records: PendingRecord[]): void {
    localStorage.setItem(KEY, JSON.stringify(records));
}

export function listRecords(): PendingRecord[] {
    return readAll();
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
