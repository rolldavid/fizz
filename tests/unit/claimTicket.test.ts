import { beforeEach, describe, expect, it } from "vitest";
import {
    decodeClaimTicket,
    encodeClaimTicket,
    validateClaimTicket,
    type ClaimTicket,
} from "../../src/lib/aztec/claimTicket";
import {
    appendToClaimInbox,
    drainClaimInbox,
    readClaimInbox,
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
    });
});

describe("claim inbox → encrypted store", () => {
    it("appends with messageHash dedupe and drains into pendingBridges", async () => {
        await appendToClaimInbox(ticket());
        await appendToClaimInbox(ticket()); // duplicate — replaced, not doubled
        expect(await readClaimInbox()).toHaveLength(1);

        const adopted = await drainClaimInbox();
        expect(adopted).toBe(1);
        expect(await readClaimInbox()).toHaveLength(0); // cleared after adopt

        const pending = await listPendingBridges("testnet");
        expect(pending).toHaveLength(1);
        expect(pending[0].claimSecret).toBe("0x0badc0de");
        expect(isClaimable(pending[0])).toBe(true);

        // Draining again with the same ticket re-delivered: store-level dedupe.
        await appendToClaimInbox(ticket());
        expect(await drainClaimInbox()).toBe(0);
        expect(await listPendingBridges("testnet")).toHaveLength(1);
    });

    it("drops invalid inbox entries loudly but keeps valid ones", async () => {
        const chrome = (globalThis as any).chrome;
        await chrome.storage.local.set({
            [CLAIM_INBOX_KEY]: [{ junk: true }, ticket()],
        });
        const valid = await readClaimInbox();
        expect(valid).toHaveLength(1);
    });

    it("ticketToPendingBridge maps complete pending entries", () => {
        const b = ticketToPendingBridge(ticket());
        expect(b.status).toBe("pending");
        expect(b.network).toBe("testnet");
        expect(b.messageLeafIndex).toBe("108535808");
        expect(isClaimable(b)).toBe(true);
    });
});
