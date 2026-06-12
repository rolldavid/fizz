import { beforeEach, describe, expect, it } from "vitest";
import { listContacts, listKnownSenders } from "../../src/lib/aztec/contacts";
import { secureSet } from "../../src/lib/secureStorage";
import { KEYS } from "../../src/lib/storage";
import { resetChromeStorage } from "../setup/chrome-stub";

/**
 * The contacts/known-sender stores are validated per-entry on READ (mirroring
 * the claim-store hardening), so a single malformed/corrupted entry can't poison
 * the whole list or crash Header.shortAddress(addr).slice during render.
 */
const ACCT = "0x" + "00".repeat(31) + "aa";
const GOOD = "0x" + "00".repeat(31) + "01";
const contactsKey = `${KEYS.contactsPrefix}.sandbox.${ACCT}`;
const sendersKey = `${KEYS.knownSendersPrefix}.sandbox.${ACCT}`;

describe("contacts: per-entry validation on read", () => {
    beforeEach(() => resetChromeStorage());

    it("drops malformed entries and keeps the valid one without throwing", async () => {
        await secureSet(contactsKey, [
            { address: 123, label: {} }, // non-string address + label (the render-crash vector)
            { address: "0xZZ", label: "bad", source: "manual", addedAt: 1 }, // unparseable address
            { address: GOOD, label: "Alice", source: "manual", addedAt: 1 }, // valid
            null,
            "not-an-object",
        ]);
        const list = await listContacts("sandbox", ACCT);
        expect(list).toHaveLength(1);
        expect(list[0].label).toBe("Alice");
        expect(typeof list[0].address).toBe("string");
    });

    it("coerces label to a trimmed, ≤32-char string and normalizes an unknown source", async () => {
        await secureSet(contactsKey, [
            { address: GOOD, label: "  " + "x".repeat(50) + "  ", source: "weird", addedAt: 5 },
        ]);
        const [c] = await listContacts("sandbox", ACCT);
        expect(c.label.length).toBeLessThanOrEqual(32);
        expect(c.label).not.toMatch(/^\s|\s$/);
        expect(["manual", "sent", "received", "imported"]).toContain(c.source);
    });

    it("returns [] (not a throw) for a wholly junk blob", async () => {
        await secureSet(contactsKey, { not: "an array" });
        expect(await listContacts("sandbox", ACCT)).toEqual([]);
    });

    it("filters malformed known-sender addresses", async () => {
        await secureSet(sendersKey, [123, "0xZZ", GOOD, null, {}]);
        const list = await listKnownSenders("sandbox", ACCT);
        expect(list).toHaveLength(1);
        expect(typeof list[0]).toBe("string");
    });
});
