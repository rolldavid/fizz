import { beforeEach, describe, expect, it } from "vitest";
import {
    decryptJson,
    deriveMetaKey,
    encryptJson,
    isEncBlob,
} from "../../src/lib/vault/metaCrypto";
import { secureGet, secureSet, setMetaKeyProvider } from "../../src/lib/secureStorage";
import { storage } from "../../src/lib/storage";
import { resetChromeStorage } from "../setup/chrome-stub";

const SEED = new Uint8Array(32).fill(7);

async function freshKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
    ]) as Promise<CryptoKey>;
}

describe("metaCrypto", () => {
    it("derives a deterministic, working key from a seed", async () => {
        const k1 = await deriveMetaKey(SEED);
        const k2 = await deriveMetaKey(SEED);
        // CryptoKey identity differs but ciphertext from one decrypts with the other.
        const blob = await encryptJson(k1, { hello: "world" }, "k");
        await expect(decryptJson(k2, blob, "k")).resolves.toEqual({ hello: "world" });
    });

    it("different seeds give incompatible keys", async () => {
        const k1 = await deriveMetaKey(SEED);
        const k2 = await deriveMetaKey(new Uint8Array(32).fill(8));
        const blob = await encryptJson(k1, ["x"], "k");
        await expect(decryptJson(k2, blob, "k")).rejects.toThrow();
    });

    it("rejects wrong seed length", async () => {
        await expect(deriveMetaKey(new Uint8Array(16))).rejects.toThrow(/32-byte/);
    });

    it("round-trips structured values exactly and marks blobs as v2", async () => {
        const key = await freshKey();
        const value = { list: [1, 2, 3], s: "claim-secret-0xabc", nested: { b: true } };
        const blob = await encryptJson(key, value, "k");
        expect(isEncBlob(blob)).toBe(true);
        expect(blob.__enc).toBe(2);
        expect(JSON.stringify(blob)).not.toContain("claim-secret"); // nothing leaks
        await expect(decryptJson(key, blob, "k")).resolves.toEqual(value);
    });

    it("AAD binds the storage key — a blob from one key won't decrypt under another", async () => {
        const key = await freshKey();
        const blob = await encryptJson(key, { spendable: "claim" }, "aztec.pendingBridges");
        // Same key, but presented as if it were a different storage key → reject.
        await expect(decryptJson(key, blob, "aztec.contacts")).rejects.toThrow();
        await expect(decryptJson(key, blob, "aztec.pendingBridges")).resolves.toEqual({
            spendable: "claim",
        });
    });
});

describe("secureStorage", () => {
    beforeEach(() => resetChromeStorage());

    it("stores values encrypted on disk — never plaintext", async () => {
        await secureSet("k1", { secret: "claim-0xdeadbeef" });
        const raw = await storage.get<unknown>("k1");
        expect(isEncBlob(raw)).toBe(true);
        expect(JSON.stringify(raw)).not.toContain("deadbeef");
        await expect(secureGet("k1")).resolves.toEqual({ secret: "claim-0xdeadbeef" });
    });

    it("migrates legacy plaintext values to encrypted on first read", async () => {
        await storage.set("legacy", [{ address: "0xabc", label: "Friend" }]);
        const out = await secureGet<any[]>("legacy");
        expect(out).toEqual([{ address: "0xabc", label: "Friend" }]);
        const raw = await storage.get<unknown>("legacy");
        expect(isEncBlob(raw)).toBe(true); // rewritten ciphertext
    });

    it("throws loudly when no key provider is installed (locked wallet)", async () => {
        const restore = await (async () => {
            // Capture by writing under the current provider first.
            await secureSet("k2", "v");
            setMetaKeyProvider(null);
            return () => {
                // Re-install the suite-wide test key provider.
                const p = crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
                    "encrypt",
                    "decrypt",
                ]);
                setMetaKeyProvider(() => p as Promise<CryptoKey>);
            };
        })();
        try {
            await expect(secureGet("k2")).rejects.toThrow(/locked/i);
            await expect(secureSet("k3", "x")).rejects.toThrow(/locked/i);
        } finally {
            restore();
        }
    });
});
