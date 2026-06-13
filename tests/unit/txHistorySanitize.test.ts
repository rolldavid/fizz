import { beforeEach, describe, expect, it } from "vitest";
import { resetChromeStorage } from "../setup/chrome-stub";
import { recordEntry, listHistory } from "../../src/lib/aztec/txHistory";
import { secureSet } from "../../src/lib/secureStorage";

const NET = "sandbox";
const ACCT = "0x" + "00".repeat(31) + "aa";
const KEY = `aztec.txHistory.v1.${NET}.${ACCT}`;

describe("txHistory — per-entry sanitize (STORAGE-25/26/27, HISTORY-20)", () => {
    beforeEach(() => resetChromeStorage());

    it("drops malformed rows on read and keeps valid ones", async () => {
        await secureSet(KEY, [
            null,
            { id: "ok1", at: Date.now(), kind: "transfer", amount: "1" },
            { id: 123, at: Date.now(), kind: "transfer" }, // non-string id
            { id: "bad", at: "nope", kind: "transfer" }, // non-number at
            { id: "bad2", at: Date.now(), kind: "bogus" }, // unknown kind
        ]);
        const out = await listHistory(NET, ACCT);
        const ids = out.map((e) => e.id);
        expect(ids).toContain("ok1");
        expect(ids).not.toContain("bad");
        expect(ids).not.toContain("bad2");
        expect(out.every((e) => typeof e.id === "string")).toBe(true);
    });
});

describe("txHistory — per-account write queue (HISTORY-18)", () => {
    beforeEach(() => resetChromeStorage());

    it("two concurrent recordEntry for the same account both persist", async () => {
        await Promise.all([
            recordEntry(NET, ACCT, { id: "t1", kind: "transfer", at: Date.now(), amount: "1" }),
            recordEntry(NET, ACCT, { id: "t2", kind: "transfer", at: Date.now(), amount: "2" }),
        ]);
        const out = await listHistory(NET, ACCT);
        const ids = out.map((e) => e.id);
        expect(ids).toContain("t1");
        expect(ids).toContain("t2");
    });

    it("dedupes by id", async () => {
        await recordEntry(NET, ACCT, { id: "dup", kind: "mint", at: Date.now(), amount: "1" });
        await recordEntry(NET, ACCT, { id: "dup", kind: "mint", at: Date.now(), amount: "1" });
        const out = (await listHistory(NET, ACCT)).filter((e) => e.id === "dup");
        expect(out).toHaveLength(1);
    });
});
