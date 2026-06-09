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
const A = "0x" + "00".repeat(31) + "01";
const B = "0x" + "00".repeat(31) + "02";

describe("contacts", () => {
    beforeEach(() => resetChromeStorage());

    it("adds, finds (canonicalized), renames, removes", async () => {
        await addContact("sandbox", { address: A, label: "Alice", source: "manual" });
        const found = await findContact("sandbox", A);
        expect(found?.label).toBe("Alice");

        await renameContact("sandbox", A, "Alicia");
        expect((await findContact("sandbox", A))?.label).toBe("Alicia");

        await removeContact("sandbox", A);
        expect(await findContact("sandbox", A)).toBeUndefined();
    });

    it("rejects duplicates, blank and oversized labels, bad addresses", async () => {
        await addContact("sandbox", { address: A, label: "Alice", source: "manual" });
        await expect(
            addContact("sandbox", { address: A, label: "Alias", source: "manual" }),
        ).rejects.toThrow(/already exists/i);
        await expect(
            addContact("sandbox", { address: B, label: "   ", source: "manual" }),
        ).rejects.toThrow(/required/i);
        await expect(
            addContact("sandbox", { address: B, label: "x".repeat(33), source: "manual" }),
        ).rejects.toThrow(/32 characters/i);
        await expect(
            addContact("sandbox", { address: "0xZZ", label: "Bad", source: "manual" }),
        ).rejects.toThrow();
    });

    it("scopes contacts per network", async () => {
        await addContact("sandbox", { address: A, label: "Alice", source: "manual" });
        expect(await listContacts("testnet")).toHaveLength(0);
        expect(await listContacts("sandbox")).toHaveLength(1);
    });

    it("known senders: dedupes and caps at 500", async () => {
        await rememberSentRecipient("sandbox", A);
        await rememberSentRecipient("sandbox", A);
        expect(await listKnownSenders("sandbox")).toHaveLength(1);

        for (let i = 1; i <= 520; i++) {
            const addr = "0x" + i.toString(16).padStart(64, "0");
            await rememberSentRecipient("sandbox", addr);
        }
        const list = await listKnownSenders("sandbox");
        expect(list.length).toBeLessThanOrEqual(500);
        // Most recent stays, oldest gets evicted.
        expect(list[0]).toBe("0x" + (520).toString(16).padStart(64, "0"));
    });
});
