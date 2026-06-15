import { beforeEach, describe, expect, it } from "vitest";
import { FEE_JUICE_ENTRY, addToken, loadTokens, removeToken } from "../../src/lib/aztec/tokens";
import { resetChromeStorage } from "../setup/chrome-stub";

const ACCT = "0x" + "00".repeat(31) + "aa";
const ACCT2 = "0x" + "00".repeat(31) + "bb";
const ADDR_A = "0x" + "11".repeat(32);
const ADDR_B = "0x" + "22".repeat(32);

describe("token registry (per-network, per-account)", () => {
    beforeEach(() => resetChromeStorage());

    it("defaults to fee juice only", async () => {
        const tokens = await loadTokens("sandbox", ACCT);
        expect(tokens).toHaveLength(1);
        expect(tokens[0].kind).toBe("fee_juice");
    });

    it("adds and persists tokens", async () => {
        await addToken("sandbox", ACCT, { address: ADDR_A, symbol: "AAA", name: "Token A", decimals: 18 });
        const tokens = await loadTokens("sandbox", ACCT);
        expect(tokens.map((t) => t.address)).toContain(ADDR_A);
        expect(tokens.find((t) => t.address === ADDR_A)?.kind).toBe("token");
    });

    it("scopes tokens per account — one account's imports never leak to another", async () => {
        await addToken("sandbox", ACCT, { address: ADDR_A, symbol: "AAA", name: "Token A", decimals: 18 });
        const other = await loadTokens("sandbox", ACCT2);
        expect(other.map((t) => t.address)).not.toContain(ADDR_A);
    });

    it("scopes tokens per network — sandbox imports never leak to testnet", async () => {
        await addToken("sandbox", ACCT, { address: ADDR_A, symbol: "AAA", name: "Token A", decimals: 18 });
        const testnetTokens = await loadTokens("testnet", ACCT);
        expect(testnetTokens.map((t) => t.address)).not.toContain(ADDR_A);
    });

    it("rejects duplicates case-insensitively", async () => {
        await addToken("sandbox", ACCT, { address: ADDR_A, symbol: "AAA", name: "Token A", decimals: 18 });
        await expect(
            addToken("sandbox", ACCT, { address: ADDR_A.toUpperCase().replace("0X", "0x"), symbol: "AAA2", name: "Dup", decimals: 18 }),
        ).rejects.toThrow(/already imported/i);
    });

    // The deploy + crash-recovery paths pass ifExists:"ignore": a token that's
    // already in the list IS their success condition, so a duplicate add must
    // be an idempotent no-op — NOT the throw that once flipped a landed deploy
    // to "Deploying X failed: Token already imported."
    it("ifExists:'ignore' makes a duplicate add an idempotent no-op", async () => {
        await addToken("sandbox", ACCT, { address: ADDR_A, symbol: "AAA", name: "Token A", decimals: 18 });
        const after = await addToken(
            "sandbox",
            ACCT,
            { address: ADDR_A, symbol: "IGNORED", name: "Re-add", decimals: 6 },
            { ifExists: "ignore" },
        );
        // Resolves (no throw), and the original entry is untouched — not duplicated.
        expect(after.filter((t) => t.address.toLowerCase() === ADDR_A.toLowerCase())).toHaveLength(1);
        expect(after.find((t) => t.address === ADDR_A)?.symbol).toBe("AAA");
    });

    it("removeToken removes the token but never fee juice", async () => {
        await addToken("sandbox", ACCT, { address: ADDR_A, symbol: "AAA", name: "Token A", decimals: 18 });
        await addToken("sandbox", ACCT, { address: ADDR_B, symbol: "BBB", name: "Token B", decimals: 6 });
        const after = await removeToken("sandbox", ACCT, ADDR_A);
        expect(after.map((t) => t.address)).not.toContain(ADDR_A);
        expect(after.map((t) => t.address)).toContain(ADDR_B);
        expect(after.some((t) => t.kind === "fee_juice")).toBe(true);
        const afterFee = await removeToken("sandbox", ACCT, FEE_JUICE_ENTRY.address);
        expect(afterFee.some((t) => t.kind === "fee_juice")).toBe(true);
    });

    it("migrates a legacy global token list to sandbox once", async () => {
        const { KEYS, storage } = await import("../../src/lib/storage");
        const legacy = [
            FEE_JUICE_ENTRY,
            { address: ADDR_A, symbol: "OLD", name: "Legacy", decimals: 18, kind: "token" },
        ];
        await storage.set(KEYS.tokens, legacy);
        const sandbox = await loadTokens("sandbox", ACCT);
        expect(sandbox.map((t) => t.address)).toContain(ADDR_A);
        // Legacy key is gone; testnet unaffected.
        expect(await storage.get(KEYS.tokens)).toBeUndefined();
        expect((await loadTokens("testnet", ACCT)).map((t) => t.address)).not.toContain(ADDR_A);
    });

    it("re-injects fee juice if a stored list lost it", async () => {
        const { KEYS, storage } = await import("../../src/lib/storage");
        await addToken("sandbox", ACCT, { address: ADDR_A, symbol: "AAA", name: "Token A", decimals: 18 });
        const k = `${KEYS.tokens}.sandbox.${ACCT}`;
        const stored = (await storage.get<any[]>(k))!.filter((t) => t.kind !== "fee_juice");
        await storage.set(k, stored);
        const tokens = await loadTokens("sandbox", ACCT);
        expect(tokens.some((t) => t.kind === "fee_juice")).toBe(true);
    });
});
