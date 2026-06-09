import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
    ARGON2_DEFAULTS,
    b64,
    decrypt,
    encrypt,
    importContentKey,
    vaultAAD,
} from "../../src/lib/vault/crypto";
import { isValidMnemonic, mnemonicToSeed, newMnemonic } from "../../src/lib/vault/mnemonic";

/**
 * Fuzz the vault envelope crypto: arbitrary payloads must round-trip exactly,
 * and ANY single-bit corruption of ciphertext, IV, or AAD must fail closed.
 */

async function freshKey() {
    return importContentKey(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

describe("fuzz: vault AES-GCM envelope", () => {
    it("round-trips arbitrary payloads exactly", async () => {
        await fc.assert(
            fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 2048 }), async (payload) => {
                const key = await freshKey();
                const aad = vaultAAD({ v: 2, method: "passphrase", salt: "c2FsdA==", kdf: ARGON2_DEFAULTS });
                const blob = await encrypt(key, payload, aad);
                const out = await decrypt(key, blob, aad);
                expect(Buffer.from(out).equals(Buffer.from(payload))).toBe(true);
            }),
            { numRuns: 40 },
        );
    });

    it("any single bit-flip in ciphertext or IV fails authentication", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.uint8Array({ minLength: 1, maxLength: 512 }),
                fc.nat(),
                fc.boolean(),
                async (payload, flipSeed, flipIv) => {
                    const key = await freshKey();
                    const blob = await encrypt(key, payload);
                    const target = b64.decode(flipIv ? blob.iv : blob.ct);
                    const idx = flipSeed % target.length;
                    const bit = 1 << flipSeed % 8;
                    target[idx] ^= bit;
                    const tampered = flipIv
                        ? { iv: b64.encode(target), ct: blob.ct }
                        : { iv: blob.iv, ct: b64.encode(target) };
                    await expect(decrypt(key, tampered)).rejects.toThrow();
                },
            ),
            { numRuns: 40 },
        );
    });

    it("AAD variations never authenticate across metadata shapes", async () => {
        const metaArb = fc.record({
            v: fc.integer({ min: 1, max: 5 }),
            method: fc.constantFrom("passphrase" as const, "passkey" as const),
            salt: fc.option(fc.base64String({ minLength: 4, maxLength: 24 }), { nil: undefined }),
            credentialId: fc.option(fc.hexaString({ minLength: 4, maxLength: 24 }), { nil: undefined }),
            prfSalt: fc.option(fc.base64String({ minLength: 4, maxLength: 24 }), { nil: undefined }),
        });
        await fc.assert(
            fc.asyncProperty(metaArb, metaArb, async (m1, m2) => {
                fc.pre(JSON.stringify(m1) !== JSON.stringify(m2));
                const key = await freshKey();
                const blob = await encrypt(key, new TextEncoder().encode("x"), vaultAAD(m1));
                await expect(decrypt(key, blob, vaultAAD(m2))).rejects.toThrow();
            }),
            { numRuns: 30 },
        );
    });
});

describe("fuzz: mnemonic validation", () => {
    it("random strings are essentially never valid mnemonics; mnemonicToSeed never returns garbage", () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 200 }), (s) => {
                if (isValidMnemonic(s)) {
                    // Vanishingly unlikely for random strings — but if fc found one,
                    // it must round-trip through seed derivation deterministically.
                    const a = mnemonicToSeed(s);
                    const b = mnemonicToSeed(s);
                    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
                } else {
                    expect(() => mnemonicToSeed(s)).toThrow();
                }
            }),
            { numRuns: 3000 },
        );
    });

    it("generated mnemonics are always valid, 12 words, distinct", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 50; i++) {
            const m = newMnemonic();
            expect(isValidMnemonic(m)).toBe(true);
            expect(m.split(" ")).toHaveLength(12);
            seen.add(m);
        }
        expect(seen.size).toBe(50);
    });
});
