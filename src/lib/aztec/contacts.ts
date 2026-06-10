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
 * Contacts are scoped per-network (a testnet contact does not follow you to
 * mainnet). They live in chrome.storage.local; they are not on-chain and never
 * notify the contact.
 *
 * Removing a contact removes the local copy AND calls `pxe.removeSender` so the
 * PXE stops syncing that sender's tag stream.
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { KEYS } from "../storage";
import { secureGet, secureSet } from "../secureStorage";
import type { AztecNetwork } from "./networks";
import type { AztecWallet } from "./wallet";

/** Short, non-identifying prefix for log lines — never log a full address
 *  (devtools/screen-share/console-scraping leak vectors). */
const redact = (a: string): string => (a.length > 12 ? `${a.slice(0, 10)}…` : a);

export type ContactSource = "manual" | "sent" | "received" | "imported";

export type Contact = {
    address: string;
    label: string;
    addedAt: number;
    source: ContactSource;
};

function key(networkId: AztecNetwork["id"]): string {
    return `${KEYS.contactsPrefix}.${networkId}`;
}

function normalizeAddress(value: string): string {
    // AztecAddress.fromString throws on invalid; .toString re-emits canonical form.
    return AztecAddress.fromString(value.trim()).toString();
}

export async function listContacts(networkId: AztecNetwork["id"]): Promise<Contact[]> {
    return (await secureGet<Contact[]>(key(networkId))) ?? [];
}

async function writeContacts(networkId: AztecNetwork["id"], contacts: Contact[]): Promise<void> {
    await secureSet(key(networkId), contacts);
}

export async function findContact(
    networkId: AztecNetwork["id"],
    address: string,
): Promise<Contact | undefined> {
    const all = await listContacts(networkId);
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
    input: AddContactInput,
    wallet?: AztecWallet | null,
): Promise<Contact> {
    const canon = normalizeAddress(input.address);
    const label = input.label.trim();
    if (!label) throw new Error("Contact label is required.");
    if (label.length > 32) throw new Error("Contact label must be 32 characters or fewer.");

    const existing = await listContacts(networkId);
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
    await writeContacts(networkId, [contact, ...existing]);

    if (wallet) {
        try {
            await wallet.registerSender(AztecAddress.fromString(canon), label);
        } catch (err) {
            // Surface but don't roll back: the contact is saved locally; PXE
            // registration will retry on next boot via syncContactsToPxe.
            console.warn("registerSender failed for", redact(canon), err);
        }
    }
    return contact;
}

export async function removeContact(
    networkId: AztecNetwork["id"],
    address: string,
    wallet?: AztecWallet | null,
): Promise<Contact[]> {
    const canon = normalizeAddress(address);
    const next = (await listContacts(networkId)).filter((c) => c.address !== canon);
    await writeContacts(networkId, next);
    if (wallet) {
        try {
            await (wallet as any).pxe.removeSender(AztecAddress.fromString(canon));
        } catch (err) {
            // Local copy is already gone; PXE will simply keep syncing this tag
            // stream until next wipe. Log, don't fail the removal.
            console.warn("removeSender failed for", redact(canon), err);
        }
    }
    return next;
}

export async function renameContact(
    networkId: AztecNetwork["id"],
    address: string,
    label: string,
): Promise<void> {
    const canon = normalizeAddress(address);
    const trimmed = label.trim();
    if (!trimmed) throw new Error("Label is required.");
    const next = (await listContacts(networkId)).map((c) =>
        c.address === canon ? { ...c, label: trimmed } : c,
    );
    await writeContacts(networkId, next);
}

/**
 * Push every locally-saved contact into the PXE address book. Called once after
 * the wallet boots so incoming notes from known senders fast-sync from this
 * session onward.
 */
export async function syncContactsToPxe(
    networkId: AztecNetwork["id"],
    wallet: AztecWallet,
): Promise<void> {
    const contacts = await listContacts(networkId);
    if (contacts.length === 0) return;
    await Promise.all(
        contacts.map(async (c) => {
            try {
                await wallet.registerSender(AztecAddress.fromString(c.address), c.label);
            } catch (err) {
                console.warn("registerSender failed during sync for", redact(c.address), err);
            }
        }),
    );
}

// ── Known senders (the broad "checked list") ────────────────────────────────
// Aztec can only discover a private note if the recipient has registered the
// sender. So beyond named contacts, we also remember every address you've SENT
// to: if they later send you something private, it's found on the fast tagged
// path instead of being invisible. This list is unnamed (distinct from
// contacts), persisted per-network, and re-registered on boot.

const MAX_KNOWN_SENDERS = 500;

function sendersKey(networkId: AztecNetwork["id"]): string {
    return `${KEYS.knownSendersPrefix}.${networkId}`;
}

export async function listKnownSenders(networkId: AztecNetwork["id"]): Promise<string[]> {
    return (await secureGet<string[]>(sendersKey(networkId))) ?? [];
}

/**
 * Record an address you've sent to as a known sender (and register it with the
 * PXE now if a wallet is provided). Safe to call on every send — dedupes, and
 * registering an existing sender is a no-op.
 */
export async function rememberSentRecipient(
    networkId: AztecNetwork["id"],
    address: string,
    wallet?: AztecWallet | null,
): Promise<void> {
    const canon = normalizeAddress(address);
    const list = await listKnownSenders(networkId);
    if (!list.includes(canon)) {
        await secureSet(sendersKey(networkId), [canon, ...list].slice(0, MAX_KNOWN_SENDERS));
    }
    if (wallet) {
        try {
            // Register for tag discovery only (no wallet-DB alias — these aren't
            // named contacts). The PXE keys senders by address, so this is the
            // discovery primitive without an address-book entry.
            await (wallet as any).pxe.registerSender(AztecAddress.fromString(canon));
        } catch (err) {
            console.warn("registerSender (sent recipient) failed for", redact(canon), err);
        }
    }
}

/**
 * Re-register all remembered senders into the PXE after boot, alongside
 * syncContactsToPxe, so reciprocal private payments stay discoverable across
 * sessions / a fresh PXE.
 */
export async function syncKnownSendersToPxe(
    networkId: AztecNetwork["id"],
    wallet: AztecWallet,
): Promise<void> {
    const list = await listKnownSenders(networkId);
    if (list.length === 0) return;
    await Promise.all(
        list.map(async (addr) => {
            try {
                await (wallet as any).pxe.registerSender(AztecAddress.fromString(addr));
            } catch (err) {
                console.warn("registerSender (known-sender sync) failed for", redact(addr), err);
            }
        }),
    );
}
