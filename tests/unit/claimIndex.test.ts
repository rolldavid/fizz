import { beforeEach, describe, expect, it } from "vitest";
import { resetChromeStorage } from "../setup/chrome-stub";
import { allocateClaimIndex, nextClaimIndex } from "../../src/lib/aztec/claimRecovery";

const NET = "sandbox";
const ACCT = "0x" + "00".repeat(31) + "aa";

describe("allocateClaimIndex (STORAGE-28, CONCURRENCY-07/17)", () => {
    beforeEach(() => resetChromeStorage());

    it("two concurrent allocations return distinct, monotonic indices", async () => {
        const [a, b] = await Promise.all([
            allocateClaimIndex(NET, ACCT),
            allocateClaimIndex(NET, ACCT),
        ]);
        expect(new Set([a, b]).size).toBe(2); // never the same index
        expect(Math.min(a, b)).toBe(0);
        expect(Math.max(a, b)).toBe(1);
        // The counter is now past both.
        expect(await nextClaimIndex(NET, ACCT)).toBe(2);
    });

    it("a burst of allocations yields a contiguous unique set", async () => {
        const ids = await Promise.all(Array.from({ length: 8 }, () => allocateClaimIndex(NET, ACCT)));
        expect(new Set(ids).size).toBe(8);
        expect(ids.slice().sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });
});
