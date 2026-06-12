import { describe, expect, it } from "vitest";
import {
    decrypt,
    deriveKeyFromPassphrase,
    encrypt,
    importContentKey,
    type Argon2Params,
} from "../../src/lib/vault/crypto";
import { isAcceptablePassphrase, passwordStrength } from "../../src/lib/vault/passwordStrength";

/**
 * The vault passphrase is NFKC-normalized before the KDF, so the SAME logical
 * passphrase entered in a different Unicode form (NFC paste vs NFD type) derives
 * the SAME key — otherwise a non-ASCII passphrase could permanently lock the
 * vault. These tests use deliberately tiny Argon2 params so they stay fast; the
 * normalization choke point is identical regardless of cost parameters.
 */
const FAST: Argon2Params = { algo: "argon2id", m: 8, t: 1, p: 1 };
const SALT = new Uint8Array(16).fill(7);

// Built from code points (NOT literals) so the byte form is certain and cannot
// be silently normalized by an editor/tool:
//   NFC "cafe" + U+00E9  (precomposed é)
//   NFD "cafe" + "e" + U+0301 (e + combining acute)
const SUFFIX = " a strong-enough one 123!";
const NFC = "caf" + "é" + SUFFIX;
const NFD = "cafe" + "́" + SUFFIX;

describe("vault: passphrase Unicode normalization", () => {
    it("NFC and NFD forms of the same passphrase derive the same key", async () => {
        expect(NFC).not.toBe(NFD); // genuinely different byte sequences
        expect(NFC.normalize("NFKC")).toBe(NFD.normalize("NFKC"));

        const k1 = await deriveKeyFromPassphrase(NFC, SALT, FAST);
        const k2 = await deriveKeyFromPassphrase(NFD, SALT, FAST);

        // CryptoKeys are non-extractable, so prove equality by cross-decrypting:
        // a blob sealed under k1 must open under k2 iff they are the same key.
        const payload = new TextEncoder().encode("the mnemonic lives here");
        const blob = await encrypt(k1, payload);
        const out = await decrypt(k2, blob);
        expect(Buffer.from(out).equals(Buffer.from(payload))).toBe(true);
    });

    it("the strength gate measures the same normalized form the KDF keys on", () => {
        expect(passwordStrength(NFC).score).toBe(passwordStrength(NFD).score);
        expect(isAcceptablePassphrase(NFC)).toBe(isAcceptablePassphrase(NFD));
    });

    it("a genuinely different passphrase still derives a different key", async () => {
        const k1 = await deriveKeyFromPassphrase("correct horse battery 9!", SALT, FAST);
        const k2 = await deriveKeyFromPassphrase("correct horse battery 8!", SALT, FAST);
        const blob = await encrypt(k1, new TextEncoder().encode("x"));
        await expect(decrypt(k2, blob)).rejects.toThrow();
    });

    it("normalize=false reproduces the raw-byte key (legacy unlock fallback)", async () => {
        // A vault created BEFORE normalization with a NON-ASCII (decomposed)
        // passphrase keyed on the raw bytes. The normalized key must NOT open it,
        // but the raw-byte fallback MUST — so the change can't brick old vaults.
        const normalized = await deriveKeyFromPassphrase(NFD, SALT, FAST, true);
        const raw = await deriveKeyFromPassphrase(NFD, SALT, FAST, false);
        const legacyBlob = await encrypt(raw, new TextEncoder().encode("legacy vault secret"));
        await expect(decrypt(normalized, legacyBlob)).rejects.toThrow(); // NFKC key can't open it
        const out = await decrypt(raw, legacyBlob); // raw fallback opens it
        expect(Buffer.from(out).toString()).toBe("legacy vault secret");
    });
});

describe("vault: AES-GCM IV uniqueness", () => {
    it("never reuses an IV across many encryptions of the same plaintext", async () => {
        const key = await importContentKey(globalThis.crypto.getRandomValues(new Uint8Array(32)));
        const payload = new TextEncoder().encode("same plaintext every time");
        const ivs = new Set<string>();
        const N = 250;
        for (let i = 0; i < N; i++) {
            const blob = await encrypt(key, payload);
            ivs.add(blob.iv);
        }
        // A reused 96-bit GCM nonce under one key is catastrophic; all must differ.
        expect(ivs.size).toBe(N);
    });
});
