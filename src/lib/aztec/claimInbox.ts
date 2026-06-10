/**
 * Adopting fee-juice claim tickets into the wallet.
 *
 * A claim ticket (from fizzwallet.com/bridge) is brought in by the user PASTING
 * it on the Bridge screen — there is NO external/cross-origin writer (the
 * background worker handles only ping/launch and never writes claims). So a
 * pasted ticket is decoded and written STRAIGHT into the encrypted
 * pendingBridges store (`adoptClaimTicket`); it never sits in plaintext.
 *
 * A claim ticket carries no spending power beyond triggering its own claim for
 * the recipient baked into the L1→L2 message, and `listReadyClaims` only ever
 * offers a claim with a live on-chain non-nullified witness — so a fabricated
 * or foreign ticket simply never becomes spendable.
 *
 * `drainClaimInbox` remains only to migrate any leftover PLAINTEXT inbox left by
 * an older build (which did route tickets through a plaintext inbox) into the
 * encrypted store on unlock, then clears it. With no writer it is a no-op.
 */

import { decodeClaimTicket, validateClaimTicket, type ClaimTicket } from "./claimTicket";
import { KEYS } from "../storage";
import { secureGet, secureSet } from "../secureStorage";
import type { PendingBridge } from "./bridge";

export const CLAIM_INBOX_KEY = "fizz.claimInbox.v1";

function localArea(): { get: Function; set: Function } {
    const area = (globalThis as any).chrome?.storage?.local;
    if (!area) throw new Error("chrome.storage.local unavailable.");
    return area;
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

/** Write a validated ticket straight into the encrypted store. Dedupe by messageHash. */
async function adoptTickets(tickets: ClaimTicket[]): Promise<number> {
    if (tickets.length === 0) return 0;
    const existing = (await secureGet<PendingBridge[]>(KEYS.pendingBridges)) ?? [];
    const known = new Set(existing.map((b) => b.messageHash).filter(Boolean));
    const fresh = tickets.filter((t) => !known.has(t.messageHash));
    if (fresh.length > 0) {
        await secureSet(KEYS.pendingBridges, [...fresh.map(ticketToPendingBridge), ...existing]);
    }
    return fresh.length;
}

/**
 * Manual import: paste a ticket string on the Bridge screen. Decodes (which
 * validates) and writes encrypted — no plaintext hop. Returns 1 if newly
 * adopted, 0 if already present.
 */
export async function importClaimTicketText(text: string): Promise<number> {
    return adoptTickets([decodeClaimTicket(text)]);
}

/**
 * Migrate any leftover PLAINTEXT inbox from an older build into the encrypted
 * store, then clear it. No current code writes the inbox, so this is normally a
 * no-op; kept for clean upgrades. Requires the vault unlocked (meta key).
 */
export async function drainClaimInbox(): Promise<number> {
    const got = await localArea().get(CLAIM_INBOX_KEY);
    const raw = got?.[CLAIM_INBOX_KEY];
    if (!Array.isArray(raw) || raw.length === 0) return 0;
    const valid: ClaimTicket[] = [];
    for (const t of raw) {
        try {
            valid.push(validateClaimTicket(t));
        } catch (err) {
            // One corrupt entry must not block the migration — drop it loudly.
            console.error("Dropping invalid legacy claim-inbox entry:", err);
        }
    }
    const adopted = await adoptTickets(valid);
    await localArea().set({ [CLAIM_INBOX_KEY]: [] }); // clear only after the encrypted write
    return adopted;
}
