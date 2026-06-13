/**
 * Contacts.
 *
 * A Contact is a local (label, address) pair we register with the PXE as a
 * "known sender." In Aztec, private-note discovery is tag-stream based and keyed
 * on the set of registered senders (plus your own accounts) — the PXE does NOT
 * trial-decrypt every published log. Consequently registering a sender is
 * REQUIRED to receive private notes from them: until a sender is registered,
 * private transfers they send you are never discovered and won't show in your
 * balance. (Public transfers are unaffected — public state isn't tagged.)
 *
 * Contacts are scoped per-network AND per-account: accounts are independent
 * identities, so account 2 never sees (or shows) account 1's address book. The
 * PXE-level sender registration is necessarily wallet-wide — one local PXE
 * discovers notes for all derived accounts — so on boot we register the UNION
 * of every account's contacts. That registration is invisible (local tag
 * sync only); the per-account separation governs everything user-facing.
 *
 * Removing a contact removes the local copy, and calls `pxe.removeSender` only
 * when no OTHER account still lists that address — otherwise their private
 * notes would silently stop being discovered for the account that kept it.
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { KEYS } from "../storage";
import { secureGet, secureSet } from "../secureStorage";
import { describeError, redact } from "../errors";
import type { AztecNetwork } from "./networks";
import type { AztecWallet } from "./wallet";


export type ContactSource = "manual" | "sent" | "received" | "imported";

export type Contact = {
    address: string;
    label: string;
    addedAt: number;
    source: ContactSource;
};

function networkKey(networkId: AztecNetwork["id"]): string {
    return `${KEYS.contactsPrefix}.${networkId}`;
}

function key(networkId: AztecNetwork["id"], account: string): string {
    return `${KEYS.contactsPrefix}.${networkId}.${account}`;
}

function normalizeAddress(value: string): string {
    // AztecAddress.fromString throws on invalid; .toString re-emits canonical form.
    return AztecAddress.fromString(value.trim()).toString();
}

/**
 * Per-entry validation on READ. The claim store was hardened this way
 * (commits a3ea57c / 9746fd2) so one malformed entry can't poison the whole
 * list; mirror it here. A non-string / non-parseable address would otherwise
 * reach Header.shortAddress(addr).slice and white-screen the Contacts page and
 * Send picker. We FILTER on read (no re-persist — a read-with-side-effect would
 * race writeContacts); the next normal write flushes the cleaned list.
 */
function sanitizeContacts(list: unknown): Contact[] {
    if (!Array.isArray(list)) return [];
    const out: Contact[] = [];
    for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const c = raw as Record<string, unknown>;
        if (typeof c.address !== "string") continue;
        let address: string;
        try {
            address = normalizeAddress(c.address);
        } catch {
            continue; // unparseable address — drop the entry, don't crash render
        }
        const label = typeof c.label === "string" ? c.label.trim().slice(0, 32) : "";
        const source: ContactSource =
            c.source === "sent" || c.source === "received" || c.source === "imported"
                ? c.source
                : "manual";
        const addedAt = typeof c.addedAt === "number" ? c.addedAt : 0;
        out.push({ address, label, addedAt, source });
    }
    return out;
}

export async function listContacts(
    networkId: AztecNetwork["id"],
    account: string,
): Promise<Contact[]> {
    let stored = await secureGet<Contact[]>(key(networkId, account));
    if (!stored) {
        // Seed migration from the per-network era: a COPY, so every existing
        // account keeps the contacts it had before the per-account split.
        const networkLevel = await secureGet<Contact[]>(networkKey(networkId));
        if (networkLevel) {
            stored = networkLevel;
            await secureSet(key(networkId, account), networkLevel);
        }
    }
    return sanitizeContacts(stored);
}

async function writeContacts(
    networkId: AztecNetwork["id"],
    account: string,
    contacts: Contact[],
): Promise<void> {
    await secureSet(key(networkId, account), contacts);
}

export async function findContact(
    networkId: AztecNetwork["id"],
    account: string,
    address: string,
): Promise<Contact | undefined> {
    const all = await listContacts(networkId, account);
    const canon = normalizeAddress(address);
    return all.find((c) => c.address === canon);
}

export type AddContactInput = {
    address: string;
    label: string;
    source: ContactSource;
};

/** Hard cap so the stored list (and the PXE tag set it feeds) stays bounded. */
const MAX_CONTACTS = 200;

export async function addContact(
    networkId: AztecNetwork["id"],
    account: string,
    input: AddContactInput,
    wallet?: AztecWallet | null,
): Promise<Contact> {
    const canon = normalizeAddress(input.address);
    const label = input.label.trim();
    if (!label) throw new Error("Contact label is required.");
    if (label.length > 32) throw new Error("Contact label must be 32 characters or fewer.");

    const existing = await listContacts(networkId, account);
    if (existing.some((c) => c.address === canon)) {
        throw new Error("Contact already exists.");
    }
    if (existing.length >= MAX_CONTACTS) {
        throw new Error(`Contact limit reached (${MAX_CONTACTS}). Remove unused contacts first.`);
    }

    const contact: Contact = {
        address: canon,
        label,
        addedAt: Date.now(),
        source: input.source,
    };
    await writeContacts(networkId, account, [contact, ...existing]);

    if (wallet) {
        try {
            await wallet.registerSender(AztecAddress.fromString(canon), label);
        } catch (err) {
            // Surface but don't roll back: the contact is saved locally; PXE
            // registration will retry on next boot via syncContactsToPxe.
            console.warn("registerSender failed for", redact(canon), describeError(err));
        }
    }
    return contact;
}

export async function removeContact(
    networkId: AztecNetwork["id"],
    account: string,
    address: string,
    wallet?: AztecWallet | null,
    /** All derived account addresses — to check no OTHER account still lists it. */
    allAccounts: string[] = [],
): Promise<Contact[]> {
    const canon = normalizeAddress(address);
    const next = (await listContacts(networkId, account)).filter((c) => c.address !== canon);
    await writeContacts(networkId, account, next);
    if (wallet) {
        // The PXE's sender set is wallet-wide. Only unregister when no other
        // account (contacts OR remembered sent-recipients) still relies on this
        // address for note discovery.
        let stillNeeded = false;
        for (const other of allAccounts) {
            if (other === account) continue;
            const theirs = await listContacts(networkId, other);
            if (theirs.some((c) => c.address === canon)) {
                stillNeeded = true;
                break;
            }
        }
        if (!stillNeeded) {
            for (const acct of allAccounts.length > 0 ? allAccounts : [account]) {
                const senders = await listKnownSenders(networkId, acct);
                if (senders.includes(canon)) {
                    stillNeeded = true;
                    break;
                }
            }
        }
        if (!stillNeeded) {
            try {
                await (wallet as any).pxe.removeSender(AztecAddress.fromString(canon));
            } catch (err) {
                // Local copy is already gone; PXE will simply keep syncing this tag
                // stream until next wipe. Log, don't fail the removal.
                console.warn("removeSender failed for", redact(canon), describeError(err));
            }
        }
    }
    return next;
}

export async function renameContact(
    networkId: AztecNetwork["id"],
    account: string,
    address: string,
    label: string,
): Promise<void> {
    const canon = normalizeAddress(address);
    const trimmed = label.trim();
    if (!trimmed) throw new Error("Label is required.");
    const next = (await listContacts(networkId, account)).map((c) =>
        c.address === canon ? { ...c, label: trimmed } : c,
    );
    await writeContacts(networkId, account, next);
}

/**
 * Push every account's locally-saved contacts into the PXE address book (the
 * UNION — discovery is wallet-wide even though display is per-account). Called
 * once after the wallet boots so incoming notes from known senders fast-sync
 * from this session onward.
 */
export async function syncContactsToPxe(
    networkId: AztecNetwork["id"],
    wallet: AztecWallet,
    accounts: string[],
): Promise<void> {
    const seen = new Set<string>();
    for (const account of accounts) {
        for (const c of await listContacts(networkId, account)) {
            if (seen.has(c.address)) continue;
            seen.add(c.address);
            try {
                await wallet.registerSender(AztecAddress.fromString(c.address), c.label);
            } catch (err) {
                console.warn("registerSender failed during sync for", redact(c.address), describeError(err));
            }
        }
    }
}

// ── Known senders (the broad "checked list") ────────────────────────────────
// Aztec can only discover a private note if the recipient has registered the
// sender. So beyond named contacts, we also remember every address you've SENT
// to: if they later send you something private, it's found on the fast tagged
// path instead of being invisible. This list is unnamed (distinct from
// contacts), persisted per-network per-account, and re-registered on boot.

const MAX_KNOWN_SENDERS = 500;

function sendersNetworkKey(networkId: AztecNetwork["id"]): string {
    return `${KEYS.knownSendersPrefix}.${networkId}`;
}

function sendersKey(networkId: AztecNetwork["id"], account: string): string {
    return `${KEYS.knownSendersPrefix}.${networkId}.${account}`;
}

export async function listKnownSenders(
    networkId: AztecNetwork["id"],
    account: string,
): Promise<string[]> {
    let stored = await secureGet<string[]>(sendersKey(networkId, account));
    if (!stored) {
        const networkLevel = await secureGet<string[]>(sendersNetworkKey(networkId));
        if (networkLevel) {
            stored = networkLevel;
            await secureSet(sendersKey(networkId, account), networkLevel);
        }
    }
    // Drop any malformed entry per-entry so one bad value can't break sender
    // registration (or crash a consumer that assumes string addresses).
    if (!Array.isArray(stored)) return [];
    const out: string[] = [];
    for (const a of stored) {
        if (typeof a !== "string") continue;
        try {
            out.push(normalizeAddress(a));
        } catch {
            /* unparseable — skip */
        }
    }
    return out;
}

/**
 * Record an address you've sent to as a known sender (and register it with the
 * PXE now if a wallet is provided). Safe to call on every send — dedupes, and
 * registering an existing sender is a no-op.
 */
export async function rememberSentRecipient(
    networkId: AztecNetwork["id"],
    account: string,
    address: string,
    wallet?: AztecWallet | null,
): Promise<void> {
    const canon = normalizeAddress(address);
    const list = await listKnownSenders(networkId, account);
    if (!list.includes(canon)) {
        await secureSet(sendersKey(networkId, account), [canon, ...list].slice(0, MAX_KNOWN_SENDERS));
    }
    if (wallet) {
        try {
            // Register for tag discovery only (no wallet-DB alias — these aren't
            // named contacts). The PXE keys senders by address, so this is the
            // discovery primitive without an address-book entry.
            await (wallet as any).pxe.registerSender(AztecAddress.fromString(canon));
        } catch (err) {
            console.warn("registerSender (sent recipient) failed for", redact(canon), describeError(err));
        }
    }
}

/**
 * Re-register all remembered senders (every account's list) into the PXE after
 * boot, alongside syncContactsToPxe, so reciprocal private payments stay
 * discoverable across sessions / a fresh PXE.
 */
export async function syncKnownSendersToPxe(
    networkId: AztecNetwork["id"],
    wallet: AztecWallet,
    accounts: string[],
): Promise<void> {
    const seen = new Set<string>();
    for (const account of accounts) {
        for (const addr of await listKnownSenders(networkId, account)) {
            if (seen.has(addr)) continue;
            seen.add(addr);
            try {
                await (wallet as any).pxe.registerSender(AztecAddress.fromString(addr));
            } catch (err) {
                console.warn("registerSender (known-sender sync) failed for", redact(addr), describeError(err));
            }
        }
    }
}
