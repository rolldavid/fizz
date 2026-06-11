import { beforeEach, describe, expect, it } from "vitest";
import {
    addContact,
    findContact,
    listContacts,
    listKnownSenders,
    rememberSentRecipient,
    removeContact,
    renameContact,
} from "../../src/lib/aztec/contacts";
import { resetChromeStorage } from "../setup/chrome-stub";

// Valid Aztec addresses are field elements; small hex values are fine.
const ACCT = "0x" + "00".repeat(31) + "aa";
const ACCT2 = "0x" + "00".repeat(31) + "bb";
const A = "0x" + "00".repeat(31) + "01";
const B = "0x" + "00".repeat(31) + "02";

describe("contacts", () => {
    beforeEach(() => resetChromeStorage());

    it("adds, finds (canonicalized), renames, removes", async () => {
        await addContact("sandbox", ACCT, { address: A, label: "Alice", source: "manual" });
        const found = await findContact("sandbox", ACCT, A);
        expect(found?.label).toBe("Alice");

        await renameContact("sandbox", ACCT, A, "Alicia");
        expect((await findContact("sandbox", ACCT, A))?.label).toBe("Alicia");

        await removeContact("sandbox", ACCT, A);
        expect(await findContact("sandbox", ACCT, A)).toBeUndefined();
    });

    it("rejects duplicates, blank and oversized labels, bad addresses", async () => {
        await addContact("sandbox", ACCT, { address: A, label: "Alice", source: "manual" });
        await expect(
            addContact("sandbox", ACCT, { address: A, label: "Alias", source: "manual" }),
        ).rejects.toThrow(/already exists/i);
        await expect(
            addContact("sandbox", ACCT, { address: B, label: "   ", source: "manual" }),
        ).rejects.toThrow(/required/i);
        await expect(
            addContact("sandbox", ACCT, { address: B, label: "x".repeat(33), source: "manual" }),
        ).rejects.toThrow(/32 characters/i);
        await expect(
            addContact("sandbox", ACCT, { address: "0xZZ", label: "Bad", source: "manual" }),
        ).rejects.toThrow();
    });

    it("scopes contacts per account", async () => {
        await addContact("sandbox", ACCT, { address: A, label: "Alice", source: "manual" });
        expect(await listContacts("sandbox", ACCT2)).toHaveLength(0);
        expect(await listContacts("sandbox", ACCT)).toHaveLength(1);
        await rememberSentRecipient("sandbox", ACCT, B);
        expect(await listKnownSenders("sandbox", ACCT2)).toHaveLength(0);
    });

    it("scopes contacts per network", async () => {
        await addContact("sandbox", ACCT, { address: A, label: "Alice", source: "manual" });
        expect(await listContacts("testnet", ACCT)).toHaveLength(0);
        expect(await listContacts("sandbox", ACCT)).toHaveLength(1);
    });

    it("known senders: dedupes and caps at 500", async () => {
        await rememberSentRecipient("sandbox", ACCT, A);
        await rememberSentRecipient("sandbox", ACCT, A);
        expect(await listKnownSenders("sandbox", ACCT)).toHaveLength(1);

        for (let i = 1; i <= 520; i++) {
            const addr = "0x" + i.toString(16).padStart(64, "0");
            await rememberSentRecipient("sandbox", ACCT, addr);
        }
        const list = await listKnownSenders("sandbox", ACCT);
        expect(list.length).toBeLessThanOrEqual(500);
        // Most recent stays, oldest gets evicted.
        expect(list[0]).toBe("0x" + (520).toString(16).padStart(64, "0"));
    });
});
