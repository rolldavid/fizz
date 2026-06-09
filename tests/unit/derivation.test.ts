import { describe, expect, it } from "vitest";
import {
    DERIVATION_VERSION,
    deriveAccount,
    exportAccountSecretHex,
} from "../../src/lib/aztec/wallet";
import { mnemonicToSeed } from "../../src/lib/vault/mnemonic";

/**
 * PINNED VECTORS — these encode the exact mnemonic → account-secret mapping of
 * DERIVATION_VERSION 1. If any of these change, every user's address changes
 * and their funds become unreachable. Never "fix" these expectations; fix the
 * code that broke them, or ship an explicit migration.
 */
const MNEMONIC = "test test test test test test test test test test test junk";
const PINNED = {
    seedHex: "9dfc3c64c2f8bede1533b6a79f8570e5943e0b8fd1cf77107adf7b72cef42185",
    secret0: "0x0cb048c810a23b1251897c4a9251953a2f022ff7612ddd145209618e86d45eec",
    secret1: "0x2aff2f258cd060afb0cb77786a05a73f14e195991ba24784e66a74de0b9028cf",
};

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("account derivation (DERIVATION_VERSION 1)", () => {
    it("derivation version is 1 — bumping requires a migration plan", () => {
        expect(DERIVATION_VERSION).toBe(1);
    });

    it("mnemonic → seed matches the pinned vector", () => {
        const seed = mnemonicToSeed(MNEMONIC);
        expect(seed.length).toBe(32);
        expect(hex(seed)).toBe(PINNED.seedHex);
    });

    it("seed → account secret matches the pinned vectors (indices 0 and 1)", async () => {
        const seed = mnemonicToSeed(MNEMONIC);
        const a0 = await deriveAccount(seed, 0);
        const a1 = await deriveAccount(seed, 1);
        expect(a0.secret.toString()).toBe(PINNED.secret0);
        expect(a1.secret.toString()).toBe(PINNED.secret1);
        expect(a0.salt.isZero()).toBe(true);
        expect(a1.salt.isZero()).toBe(true);
    });

    it("is deterministic across calls", async () => {
        const seed = mnemonicToSeed(MNEMONIC);
        const x = await deriveAccount(seed, 0);
        const y = await deriveAccount(seed, 0);
        expect(x.secret.toString()).toBe(y.secret.toString());
    });

    it("distinct account indices give distinct secrets", async () => {
        const seed = mnemonicToSeed(MNEMONIC);
        const secrets = await Promise.all(
            [0, 1, 2, 3, 4].map((i) => deriveAccount(seed, i).then((a) => a.secret.toString())),
        );
        expect(new Set(secrets).size).toBe(secrets.length);
    });

    it("exportAccountSecretHex equals the derived secret", async () => {
        const seed = mnemonicToSeed(MNEMONIC);
        const a0 = await deriveAccount(seed, 0);
        await expect(exportAccountSecretHex(seed, 0)).resolves.toBe(a0.secret.toString());
    });

    it("different mnemonics give different secrets", async () => {
        const other = mnemonicToSeed(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        );
        const a = await deriveAccount(mnemonicToSeed(MNEMONIC), 0);
        const b = await deriveAccount(other, 0);
        expect(a.secret.toString()).not.toBe(b.secret.toString());
    });
});

describe("mnemonic", () => {
    it("rejects invalid phrases", () => {
        expect(() => mnemonicToSeed("not a real phrase at all")).toThrow(/Invalid recovery phrase/);
        expect(() => mnemonicToSeed("")).toThrow();
    });

    it("normalizes interior whitespace", () => {
        const messy = "test  test   test test\ttest test test test test test test junk";
        expect(hex(mnemonicToSeed(messy))).toBe(PINNED.seedHex);
    });
});
