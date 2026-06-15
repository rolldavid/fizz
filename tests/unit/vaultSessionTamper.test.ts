import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { vaultStore } from "../../src/lib/vault/store";
import { newMnemonic } from "../../src/lib/vault/mnemonic";
import { resetChromeStorage } from "../setup/chrome-stub";

// CRYPTO-46/50 — the session seed cache is authenticated with an HMAC bound to
// THIS vault's key-derivation identity (salt/KDF or credentialId/prfSalt). A
// substituted seed (the poisoned-Receive → deposit-theft attack), a tag minted
// under a different/recreated vault, or a missing tag MUST fail closed: the
// wallet must not unlock on unverified session data, and the bad blob must
// self-clear. There was no automated coverage; this pins it through the real
// vaultStore + the real WebCrypto HMAC (not a mock of the predicate).

const SESSION_KEY = "fizz.unlock.session.v1"; // store.ts — stable storage key
const PASS = "vivid-marble-acrobat-cherry-flute-42!";

function session() {
    return (globalThis as any).chrome.storage.session as {
        get: (k: string) => Promise<Record<string, any>>;
        set: (o: Record<string, unknown>) => Promise<void>;
        remove: (k: string) => Promise<void>;
    };
}

async function waitForSessionBlob(): Promise<{ seed: string; at: number; mac: string }> {
    for (let i = 0; i < 200; i++) {
        const got = await session().get(SESSION_KEY);
        if (got?.[SESSION_KEY]) return got[SESSION_KEY];
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("session blob was never persisted");
}

function toHex(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
}

describe("session-blob authenticity (CRYPTO-46/50)", () => {
    let validBlob: { seed: string; at: number; mac: string };

    beforeAll(async () => {
        resetChromeStorage();
        await vaultStore.lock();
        await vaultStore.init();
        await vaultStore.createWithPassphrase(newMnemonic(), PASS);
        validBlob = await waitForSessionBlob();
    }, 30_000);

    beforeEach(async () => {
        // Simulate a closed popup: drop the live in-memory seed (and any blob).
        await vaultStore.lock();
    });

    it("a valid cached blob restores the seed on the next init (no false-negative)", async () => {
        await session().set({ [SESSION_KEY]: validBlob });
        await vaultStore.init();
        const u = vaultStore.getUnlocked();
        expect(u).not.toBeNull();
        expect(u!.seed.length).toBe(32);
        expect(toHex(u!.seed)).toBe(validBlob.seed);
    });

    it("a SUBSTITUTED seed (original MAC) fails closed and self-clears the blob", async () => {
        const otherSeed = "ab".repeat(32); // well-formed 64-hex, but NOT the MAC'd seed
        expect(otherSeed).not.toBe(validBlob.seed);
        await session().set({ [SESSION_KEY]: { ...validBlob, seed: otherSeed } });
        await vaultStore.init();
        expect(vaultStore.getUnlocked()).toBeNull();
        expect((await session().get(SESSION_KEY))[SESSION_KEY]).toBeUndefined();
    });

    it("a blob with a MISSING mac fails closed", async () => {
        await session().set({ [SESSION_KEY]: { seed: validBlob.seed, at: validBlob.at } });
        await vaultStore.init();
        expect(vaultStore.getUnlocked()).toBeNull();
    });

    it("a blob with a CORRUPTED mac fails closed", async () => {
        const last = validBlob.mac.slice(-1);
        const badMac = validBlob.mac.slice(0, -1) + (last === "A" ? "B" : "A");
        await session().set({ [SESSION_KEY]: { ...validBlob, mac: badMac } });
        await vaultStore.init();
        expect(vaultStore.getUnlocked()).toBeNull();
    });

    it("a blob MAC'd under a DIFFERENT vault is rejected (cross-vault substitution)", async () => {
        // Re-create the vault with a fresh phrase+passphrase → new salt/KDF
        // identity. The previously-valid blob (MAC'd under the OLD vault) is still
        // internally well-formed but must no longer authenticate here.
        await vaultStore.init();
        await vaultStore.createWithPassphrase(newMnemonic(), "another-strong-one-zigzag-77!");
        await waitForSessionBlob(); // the new vault's own blob
        await vaultStore.lock();
        await session().set({ [SESSION_KEY]: validBlob }); // OLD vault's blob
        await vaultStore.init();
        expect(vaultStore.getUnlocked()).toBeNull();
    }, 30_000);
});
