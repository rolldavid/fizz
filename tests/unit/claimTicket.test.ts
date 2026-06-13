import { beforeEach, describe, expect, it } from "vitest";
import {
    decodeClaimTicket,
    encodeClaimTicket,
    validateClaimTicket,
    type ClaimTicket,
} from "../../src/lib/aztec/claimTicket";
import {
    drainClaimInbox,
    importClaimTicketText,
    ticketToPendingBridge,
    CLAIM_INBOX_KEY,
} from "../../src/lib/aztec/claimInbox";
import { isClaimable, listPendingBridges } from "../../src/lib/aztec/bridge";
import { resetChromeStorage } from "../setup/chrome-stub";

const ticket = (over: Partial<ClaimTicket> = {}): ClaimTicket => ({
    v: 1,
    kind: "fee-juice-claim",
    networkId: "testnet",
    l1ChainId: 11155111,
    recipient: "0x1234abcd",
    claimAmount: "1000000000000000000000",
    claimSecret: "0x0badc0de",
    messageHash: "0x" + "ab".repeat(32),
    messageLeafIndex: "108535808",
    l1TxHash: "0x" + "cd".repeat(32),
    createdAt: 1765000000000,
    ...over,
});

beforeEach(() => resetChromeStorage());

describe("claim ticket encode/decode", () => {
    it("round-trips", () => {
        const t = ticket();
        expect(decodeClaimTicket(encodeClaimTicket(t))).toEqual(t);
    });

    // TRUST-17 — claimAmount must fit u128.
    it("rejects a claimAmount above u128", () => {
        expect(() => validateClaimTicket(ticket({ claimAmount: (1n << 128n).toString() }))).toThrow(
            /u128/i,
        );
    });
    it("accepts claimAmount exactly at the u128 max", () => {
        expect(() =>
            validateClaimTicket(ticket({ claimAmount: ((1n << 128n) - 1n).toString() })),
        ).not.toThrow();
    });

    it("survives surrounding whitespace (copy-paste reality)", () => {
        const text = `  \n${encodeClaimTicket(ticket())}\n  `;
        expect(decodeClaimTicket(text).recipient).toBe("0x1234abcd");
    });

    it("rejects wrong prefix, corruption, and field tampering", () => {
        expect(() => decodeClaimTicket("notaticket")).toThrow(/Not a Fizz claim ticket/);
        expect(() => decodeClaimTicket("fizzclaim1:%%%%")).toThrow(/corrupted/);
        expect(() => validateClaimTicket(ticket({ v: 2 as any }))).toThrow(/version/);
        expect(() => validateClaimTicket(ticket({ recipient: "1234" }))).toThrow(/0x-hex/);
        expect(() => validateClaimTicket(ticket({ claimAmount: "10.5" }))).toThrow(/decimal/);
        expect(() => validateClaimTicket(ticket({ kind: "nft" as any }))).toThrow(/kind/);
        // Length caps: oversized hex / decimal / networkId rejected.
        expect(() => validateClaimTicket(ticket({ claimSecret: "0x" + "a".repeat(200) }))).toThrow(/0x-hex/);
        expect(() => validateClaimTicket(ticket({ claimAmount: "9".repeat(100) }))).toThrow(/decimal/);
        expect(() => validateClaimTicket(ticket({ networkId: "x".repeat(40) }))).toThrow(/networkId/);
    });
});

describe("manual ticket import → encrypted store", () => {
    it("imports a pasted ticket straight into pendingBridges (no plaintext hop), dedupes", async () => {
        const text = encodeClaimTicket(ticket());
        const adopted = await importClaimTicketText(text);
        expect(adopted).toBe(1);

        const pending = await listPendingBridges("testnet");
        expect(pending).toHaveLength(1);
        expect(pending[0].claimSecret).toBe("0x0badc0de");
        expect(isClaimable(pending[0])).toBe(true);

        // Re-importing the same ticket is a store-level no-op (messageHash dedupe).
        expect(await importClaimTicketText(text)).toBe(0);
        expect(await listPendingBridges("testnet")).toHaveLength(1);
    });

    it("drainClaimInbox migrates a legacy plaintext inbox, then clears it", async () => {
        const chrome = (globalThis as any).chrome;
        // Simulate an inbox left by an older build (one junk entry + one valid).
        await chrome.storage.local.set({ [CLAIM_INBOX_KEY]: [{ junk: true }, ticket()] });
        const adopted = await drainClaimInbox();
        expect(adopted).toBe(1); // junk dropped, valid migrated
        expect(await listPendingBridges("testnet")).toHaveLength(1);
        const after = await chrome.storage.local.get(CLAIM_INBOX_KEY);
        expect(after[CLAIM_INBOX_KEY]).toEqual([]); // cleared
        // A non-array (corrupted) inbox is a safe no-op.
        await chrome.storage.local.set({ [CLAIM_INBOX_KEY]: "garbage" });
        expect(await drainClaimInbox()).toBe(0);
    });

    it("ticketToPendingBridge maps complete pending entries", () => {
        const b = ticketToPendingBridge(ticket());
        expect(b.status).toBe("pending");
        expect(b.network).toBe("testnet");
        expect(b.messageLeafIndex).toBe("108535808");
        expect(isClaimable(b)).toBe(true);
    });
});
