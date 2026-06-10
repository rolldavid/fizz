/**
 * Claim-ticket inbox — where tickets from fizzwallet.com/bridge land before
 * the wallet adopts them.
 *
 * The background service worker receives tickets via onMessageExternal and
 * can ONLY write plaintext storage (the meta encryption key lives in the
 * unlocked popup, never in the SW). So tickets wait in a plaintext inbox and
 * the popup drains them into the ENCRYPTED pendingBridges store at unlock /
 * Bridge refresh. Acceptable at-rest exposure: a ticket's worst case is
 * triggering its own claim for its fixed recipient (see claimTicket.ts), and
 * it was just displayed on a public web page anyway.
 */

import { validateClaimTicket, type ClaimTicket } from "./claimTicket";
import { KEYS } from "../storage";
import { secureGet, secureSet } from "../secureStorage";
import type { PendingBridge } from "./bridge";

export const CLAIM_INBOX_KEY = "fizz.claimInbox.v1";

function localArea(): { get: Function; set: Function } {
    const area = (globalThis as any).chrome?.storage?.local;
    if (!area) throw new Error("chrome.storage.local unavailable.");
    return area;
}

export async function readClaimInbox(): Promise<ClaimTicket[]> {
    const got = await localArea().get(CLAIM_INBOX_KEY);
    const raw = (got?.[CLAIM_INBOX_KEY] as unknown[]) ?? [];
    const valid: ClaimTicket[] = [];
    for (const t of raw) {
        try {
            valid.push(validateClaimTicket(t));
        } catch (err) {
            // One corrupt/malicious ticket must not brick the wallet — drop it
            // LOUDLY (visible in the extension console), keep the rest.
            console.error("Dropping invalid claim ticket from inbox:", err);
        }
    }
    return valid;
}

/** Used by the background service worker. Dedupes by messageHash. */
export async function appendToClaimInbox(ticket: ClaimTicket): Promise<void> {
    validateClaimTicket(ticket);
    const area = localArea();
    const got = await area.get(CLAIM_INBOX_KEY);
    const existing = ((got?.[CLAIM_INBOX_KEY] as ClaimTicket[]) ?? []).filter(
        (t) => t?.messageHash !== ticket.messageHash,
    );
    await area.set({ [CLAIM_INBOX_KEY]: [ticket, ...existing] });
}

async function writeClaimInbox(tickets: ClaimTicket[]): Promise<void> {
    await localArea().set({ [CLAIM_INBOX_KEY]: tickets });
}

/** A ticket adopted into the wallet's encrypted pending-bridge store. */
export function ticketToPendingBridge(t: ClaimTicket): PendingBridge {
    return {
        id: `ticket-${t.messageHash.slice(2, 14)}`,
        network: t.networkId as PendingBridge["network"],
        recipient: t.recipient,
        claimAmount: t.claimAmount,
        claimSecret: t.claimSecret,
        messageHash: t.messageHash,
        messageLeafIndex: t.messageLeafIndex,
        status: "pending",
        l1TxHash: t.l1TxHash,
        createdAt: t.createdAt,
    };
}

/**
 * Adopt every inbox ticket into the encrypted store (any network — entries
 * are network-tagged and surface when that network is active). Returns how
 * many were adopted. Requires the vault to be unlocked (meta key).
 */
export async function drainClaimInbox(): Promise<number> {
    const tickets = await readClaimInbox();
    if (tickets.length === 0) return 0;

    const existing = (await secureGet<PendingBridge[]>(KEYS.pendingBridges)) ?? [];
    const known = new Set(existing.map((b) => b.messageHash).filter(Boolean));
    const fresh = tickets.filter((t) => !known.has(t.messageHash));
    if (fresh.length > 0) {
        await secureSet(KEYS.pendingBridges, [...fresh.map(ticketToPendingBridge), ...existing]);
    }
    // Clear the inbox only AFTER the encrypted write succeeded.
    await writeClaimInbox([]);
    return fresh.length;
}

/** Manual fallback: paste a ticket string into the Bridge page. */
export async function importClaimTicketText(text: string): Promise<number> {
    const { decodeClaimTicket } = await import("./claimTicket");
    await appendToClaimInbox(decodeClaimTicket(text));
    return drainClaimInbox();
}
