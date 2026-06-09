import { beforeEach, describe, expect, it } from "vitest";
import {
    ARGON2_DEFAULTS,
    type Argon2Params,
    VAULT_VERSION,
    b64,
    decrypt,
    deriveKeyFromPassphrase,
    encrypt,
    importContentKey,
    randomSalt,
    vaultAAD,
} from "../../src/lib/vault/crypto";
import { vaultStore } from "../../src/lib/vault/store";
import { isAcceptablePassphrase } from "../../src/lib/vault/passwordStrength";
import { newMnemonic } from "../../src/lib/vault/mnemonic";
import { resetChromeStorage } from "../setup/chrome-stub";

/** Tiny Argon2 params so KDF-dependent tests run in milliseconds, not seconds. */
const FAST_KDF: Argon2Params = { algo: "argon2id", m: 64, t: 1, p: 1 };

function randomKeyBytes(): Uint8Array {
    return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

describe("vault crypto primitives", () => {
    it("encrypt/decrypt round-trips with AAD", async () => {
        const key = await importContentKey(randomKeyBytes());
        const aad = vaultAAD({
            v: VAULT_VERSION,
            method: "passphrase",
            salt: "c2FsdA==",
            kdf: ARGON2_DEFAULTS,
        });
        const pt = new TextEncoder().encode("twelve words of pure entropy");
        const blob = await encrypt(key, pt, aad);
        const out = await decrypt(key, blob, aad);
        expect(new TextDecoder().decode(out)).toBe("twelve words of pure entropy");
    });

    it("AAD binds the ENVELOPE version — version swap fails auth (anti-brick regression)", async () => {
        const key = await importContentKey(randomKeyBytes());
        const mkAad = (v: number) =>
            vaultAAD({ v, method: "passphrase", salt: "c2FsdA==", kdf: ARGON2_DEFAULTS });
        const blob = await encrypt(key, new TextEncoder().encode("secret"), mkAad(2));
        // Same version → decrypts; different version → tag mismatch.
        await expect(decrypt(key, blob, mkAad(2))).resolves.toBeDefined();
        await expect(decrypt(key, blob, mkAad(3))).rejects.toThrow();
        expect(() => vaultAAD({ v: 0 as any, method: "passphrase" })).toThrow(/invalid version/i);
    });

    it("fresh IV per encryption (no nonce reuse)", async () => {
        const key = await importContentKey(randomKeyBytes());
        const pt = new TextEncoder().encode("same plaintext");
        const a = await encrypt(key, pt);
        const b = await encrypt(key, pt);
        expect(a.iv).not.toBe(b.iv);
        expect(a.ct).not.toBe(b.ct);
        expect(b64.decode(a.iv).length).toBe(12);
    });

    it("rejects ciphertext tampering (GCM auth)", async () => {
        const key = await importContentKey(randomKeyBytes());
        const blob = await encrypt(key, new TextEncoder().encode("secret"));
        const ct = b64.decode(blob.ct);
        ct[0] ^= 0x01;
        await expect(decrypt(key, { iv: blob.iv, ct: b64.encode(ct) })).rejects.toThrow();
    });

    it("rejects AAD mismatch — method/salt swap invalidates the tag", async () => {
        const key = await importContentKey(randomKeyBytes());
        const aadA = vaultAAD({
            v: VAULT_VERSION,
            method: "passphrase",
            salt: "c2FsdA==",
            kdf: ARGON2_DEFAULTS,
        });
        const aadB = vaultAAD({
            v: VAULT_VERSION,
            method: "passkey",
            credentialId: "abc",
            prfSalt: "c2FsdA==",
        });
        const blob = await encrypt(key, new TextEncoder().encode("secret"), aadA);
        await expect(decrypt(key, blob, aadB)).rejects.toThrow();
        await expect(decrypt(key, blob)).rejects.toThrow(); // missing AAD also fails
    });

    it("rejects wrong key", async () => {
        const k1 = await importContentKey(randomKeyBytes());
        const k2 = await importContentKey(randomKeyBytes());
        const blob = await encrypt(k1, new TextEncoder().encode("secret"));
        await expect(decrypt(k2, blob)).rejects.toThrow();
    });

    it("importContentKey enforces 32 bytes", async () => {
        await expect(importContentKey(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
    });

    it("deriveKeyFromPassphrase: same inputs → same key; wrong passphrase fails decrypt", async () => {
        const salt = randomSalt();
        const k1 = await deriveKeyFromPassphrase("correct horse battery staple", salt, FAST_KDF);
        const blob = await encrypt(k1, new TextEncoder().encode("payload"));
        const k1b = await deriveKeyFromPassphrase("correct horse battery staple", salt, FAST_KDF);
        await expect(decrypt(k1b, blob)).resolves.toBeDefined();
        const kWrong = await deriveKeyFromPassphrase("incorrect horse", salt, FAST_KDF);
        await expect(decrypt(kWrong, blob)).rejects.toThrow();
        const kWrongSalt = await deriveKeyFromPassphrase(
            "correct horse battery staple",
            randomSalt(),
            FAST_KDF,
        );
        await expect(decrypt(kWrongSalt, blob)).rejects.toThrow();
    });

    it("vault version is 2 (envelope format)", () => {
        expect(VAULT_VERSION).toBe(2);
    });
});

describe("passphrase policy", () => {
    it("rejects weak passphrases", () => {
        for (const weak of ["short1!", "password12345", "aztecaztecaztec", "aaaaaaaaaaaaaaaa", "123456789012"]) {
            expect(isAcceptablePassphrase(weak), weak).toBe(false);
        }
    });
    it("accepts strong passphrases", () => {
        expect(isAcceptablePassphrase("Tr0ub4dor&3-horse-staple")).toBe(true);
        expect(isAcceptablePassphrase("vivid-marble-acrobat-cherry-flute")).toBe(true);
    });
});

describe("vaultStore passphrase lifecycle (real Argon2 params — slow path)", () => {
    beforeEach(() => {
        resetChromeStorage();
        // Re-init reads the (now empty) stub storage.
        vaultStore.lock();
    });

    it("create → lock → unlock → destroy", async () => {
        await vaultStore.init();
        expect(vaultStore.isInitialized()).toBe(false);

        const mnemonic = newMnemonic();
        const pass = "vivid-marble-acrobat-cherry-flute-42!";
        await vaultStore.createWithPassphrase(mnemonic, pass);
        expect(vaultStore.isInitialized()).toBe(true);
        expect(vaultStore.method()).toBe("passphrase");
        // The store retains ONLY the seed — never the mnemonic string.
        expect((vaultStore.getUnlocked() as any)?.mnemonic).toBeUndefined();
        const seedRef = vaultStore.getUnlocked()!.seed;
        expect(seedRef.length).toBe(32);

        vaultStore.lock();
        expect(vaultStore.getUnlocked()).toBeNull();
        // Seed bytes must be zeroed on lock, not just dereferenced.
        expect(Array.from(seedRef).every((x) => x === 0)).toBe(true);

        await expect(vaultStore.unlockWithPassphrase("wrong-passphrase-entirely-9!")).rejects.toThrow();
        const unlocked = await vaultStore.unlockWithPassphrase(pass);
        expect(unlocked.mnemonic).toBe(mnemonic);

        await vaultStore.destroy();
        expect(vaultStore.isInitialized()).toBe(false);
        expect(vaultStore.getUnlocked()).toBeNull();
    }, 60_000);

    it("rejects weak passphrase at the store layer (UI bypass impossible)", async () => {
        await vaultStore.init();
        await expect(vaultStore.createWithPassphrase(newMnemonic(), "weakpass")).rejects.toThrow(
            /too weak/i,
        );
    });
});
