import { beforeEach, describe, expect, it } from "vitest";
import { resetChromeStorage } from "../setup/chrome-stub";
import { addToken, loadTokens } from "../../src/lib/aztec/tokens";

const NET = "sandbox";
const ACCT = "0x" + "00".repeat(31) + "aa";
const tokenAddr = (n: number) => "0x" + n.toString(16).padStart(64, "0");

describe("tokens — concurrency + caps (CONCURRENCY-07/17/32, STORAGE-14)", () => {
    beforeEach(() => resetChromeStorage());

    it("two concurrent addToken of distinct tokens both survive (no clobber)", async () => {
        await Promise.all([
            addToken(NET, ACCT, { address: tokenAddr(1), symbol: "AAA", name: "A", decimals: 18 }),
            addToken(NET, ACCT, { address: tokenAddr(2), symbol: "BBB", name: "B", decimals: 18 }),
        ]);
        const tokens = await loadTokens(NET, ACCT);
        const addrs = tokens.map((t) => t.address);
        expect(addrs).toContain(tokenAddr(1));
        expect(addrs).toContain(tokenAddr(2));
    });

    it("rejects a duplicate import", async () => {
        await addToken(NET, ACCT, { address: tokenAddr(1), symbol: "AAA", name: "A", decimals: 18 });
        await expect(
            addToken(NET, ACCT, { address: tokenAddr(1), symbol: "AAA", name: "A", decimals: 18 }),
        ).rejects.toThrow(/already imported/i);
    });

    it("enforces the MAX_TOKENS cap", async () => {
        for (let i = 1; i <= 100; i++) {
            await addToken(NET, ACCT, {
                address: tokenAddr(i),
                symbol: "T" + i,
                name: "T",
                decimals: 18,
            });
        }
        await expect(
            addToken(NET, ACCT, { address: tokenAddr(101), symbol: "X", name: "X", decimals: 18 }),
        ).rejects.toThrow(/limit reached/i);
    });
});
