import { beforeEach, describe, expect, it } from "vitest";
import {
    dismissBridge,
    isClaimable,
    listPendingBridges,
    type PendingBridge,
} from "../../src/lib/aztec/bridge";
import { KEYS } from "../../src/lib/storage";
import { secureSet } from "../../src/lib/secureStorage";
import { resetChromeStorage } from "../setup/chrome-stub";

/**
 * Bridge entries now carry a lifecycle (depositing → sent → pending; failed).
 * Two invariants protect funds and fees:
 *   1. Only COMPLETE entries ("pending" with message fields) may be offered to
 *      fee payments — an in-flight claim attached to a tx fails simulation.
 *   2. Dismissed/consumed entries never resurface.
 */

const base = (over: Partial<PendingBridge>): PendingBridge => ({
    id: Math.random().toString(36).slice(2),
    network: "testnet",
    recipient: "0xaa",
    claimAmount: "1000",
    claimSecret: "0x01",
    createdAt: Date.now(),
    ...over,
});

beforeEach(() => resetChromeStorage());

describe("bridge claim lifecycle", () => {
    it("isClaimable accepts only complete pending entries", () => {
        expect(
            isClaimable(base({ status: "pending", messageHash: "0x02", messageLeafIndex: "5" })),
        ).toBe(true);
        // Legacy entries (pre-status) are complete by construction.
        expect(isClaimable(base({ messageHash: "0x02", messageLeafIndex: "5" }))).toBe(true);

        expect(isClaimable(base({ status: "depositing" }))).toBe(false);
        expect(isClaimable(base({ status: "sent", l1TxHash: "0x03" }))).toBe(false);
        expect(isClaimable(base({ status: "failed" }))).toBe(false);
        // Pending but incomplete fields — never offer to a fee payment.
        expect(isClaimable(base({ status: "pending" }))).toBe(false);
        // Spent or hidden.
        expect(
            isClaimable(
                base({ status: "pending", messageHash: "0x02", messageLeafIndex: "5", consumedAt: 1 }),
            ),
        ).toBe(false);
        expect(
            isClaimable(
                base({ status: "pending", messageHash: "0x02", messageLeafIndex: "5", dismissedAt: 1 }),
            ),
        ).toBe(false);
    });

    it("listPendingBridges hides dismissed and consumed entries, keeps in-flight ones visible", async () => {
        const inflight = base({ status: "depositing" });
        const complete = base({ status: "pending", messageHash: "0x02", messageLeafIndex: "5" });
        const consumed = base({
            status: "pending",
            messageHash: "0x03",
            messageLeafIndex: "6",
            consumedAt: Date.now(),
        });
        const otherNet = base({ network: "sandbox", status: "depositing" });
        await secureSet(KEYS.pendingBridges, [inflight, complete, consumed, otherNet]);

        const listed = await listPendingBridges("testnet");
        expect(listed.map((b) => b.id).sort()).toEqual([inflight.id, complete.id].sort());

        await dismissBridge(inflight.id);
        const after = await listPendingBridges("testnet");
        expect(after.map((b) => b.id)).toEqual([complete.id]);
    });
});
