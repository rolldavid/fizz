/**
 * Vault store. Holds the encrypted secret blob in chrome.storage.local and
 * exposes lock/unlock primitives. The in-memory unlocked state lives only in
 * the popup process; closing the popup re-locks the wallet.
 *
 * Secret hygiene:
 *   - The retained unlocked state is ONLY the 32-byte `seed` (zeroed on lock).
 *   - The mnemonic string is returned to the caller of unlock/create exactly
 *     once and never retained here — a JS string can't be wiped in place, so
 *     the only winning move is not to keep it. Anything that needs the phrase
 *     later (RevealPhrase) re-authenticates and re-decrypts the vault.
 *   - Plaintext byte buffers that pass through (decrypted mnemonic, the
 *     TextEncoder copy handed to encrypt) are `.fill(0)`'d as soon as they're
 *     consumed — only the un-wipeable JS string survives, briefly.
 *   - The popup CSP (default-src 'none' + pinned connect-src) blocks injected
 *     remote script AND network exfiltration paths; this is defense-in-depth.
 */

import { KEYS, storage } from "../storage";
import {
    type VaultEnvelope,
    ARGON2_DEFAULTS,
    VAULT_VERSION,
    b64,
    decrypt,
    deriveKeyFromPassphrase,
    encrypt,
    importContentKey,
    randomSalt,
    vaultAAD,
} from "./crypto";
import { registerPasskey, unlockWithPasskey } from "./passkey";
import { mnemonicToSeed } from "./mnemonic";
import { deriveMetaKey } from "./metaCrypto";
import { isAcceptablePassphrase } from "./passwordStrength";

/** What the store RETAINS while unlocked — deliberately excludes the mnemonic. */
export type UnlockedSecret = {
    /** 32-byte derivation seed (mnemonic → seed). Zeroed on lock(). */
    seed: Uint8Array;
};

/** Returned exactly once by unlock/reveal flows. Not retained by the store. */
export type RevealedSecret = {
    mnemonic: string;
    seed: Uint8Array;
};

/**
 * Envelope-format versions we have deliberately RETIRED and will not decrypt.
 * v1 predates the public release. Critically, this is an explicit retired-set,
 * NOT a `v < VAULT_VERSION` rejection: the AAD binds each envelope's OWN
 * version (crypto.ts:vaultAAD), so a future VAULT_VERSION bump leaves older
 * still-supported envelopes decryptable — bumping the format must not brick
 * every existing vault. Only add a version here when you truly drop support.
 */
const RETIRED_VAULT_VERSIONS = new Set<number>([1]);

/**
 * In-memory unlock cache (chrome.storage.session). Lets the popup re-open
 * WITHOUT re-entering the passphrase/passkey within a browser session, expiring
 * after 30 days. A deliberate convenience/security tradeoff:
 *   - session storage is MEMORY-backed: wiped on browser restart, never on disk;
 *   - only the 32-byte SEED is cached (never the mnemonic), so revealing the
 *     recovery phrase still re-authenticates against the vault;
 *   - the egress CSP still blocks exfiltration of the cached seed.
 * The residual risk this accepts: physical access to a running, recently-used
 * browser opens the wallet without the password (bounded by the 30-day cap and
 * browser-restart wipe). The idle auto-lock still clears the live in-memory seed.
 */
const SESSION_KEY = "fizz.unlock.session.v1";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sessionArea(): { get: Function; set: Function; remove: Function } | null {
    return (globalThis as any).chrome?.storage?.session ?? null;
}
function seedToHex(seed: Uint8Array): string {
    let s = "";
    for (const b of seed) s += b.toString(16).padStart(2, "0");
    return s;
}
function hexToSeed(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function decryptFailure(err: unknown): Error {
    // WebCrypto reports GCM auth failure as an opaque OperationError, which is
    // also what a wrong passphrase produces. Surface something actionable
    // without claiming more than we know.
    return new Error(
        "Could not unlock the vault. Wrong passphrase/passkey — or the stored vault data is corrupted." +
            (err instanceof Error && err.message ? ` (${err.message})` : ""),
    );
}

class VaultStore {
    private envelope: VaultEnvelope | undefined;
    private unlocked: UnlockedSecret | null = null;
    private metaKeyPromise: Promise<CryptoKey> | null = null;

    async init(): Promise<void> {
        this.envelope = await storage.get<VaultEnvelope>(KEYS.vault);
        await this.restoreSession();
    }

    /** Cache the unlocked seed in session memory so re-opening skips the prompt. */
    private async persistSession(): Promise<void> {
        const area = sessionArea();
        if (!area || !this.unlocked) return;
        await area.set({ [SESSION_KEY]: { seed: seedToHex(this.unlocked.seed), at: Date.now() } });
    }

    /** Restore a still-valid (< 30 days, same browser session) cached unlock. */
    private async restoreSession(): Promise<void> {
        const area = sessionArea();
        if (!area || this.unlocked || !this.envelope) return;
        const got = await area.get(SESSION_KEY);
        const blob = got?.[SESSION_KEY];
        if (!blob || typeof blob.seed !== "string" || typeof blob.at !== "number") return;
        if (Date.now() - blob.at > SESSION_TTL_MS) {
            await area.remove(SESSION_KEY);
            return;
        }
        const seed = hexToSeed(blob.seed);
        if (seed.length !== 32) {
            await area.remove(SESSION_KEY);
            return;
        }
        this.unlocked = { seed };
    }

    private clearSession(): void {
        void sessionArea()?.remove(SESSION_KEY);
    }

    isInitialized(): boolean {
        return this.envelope !== undefined;
    }

    method(): VaultEnvelope["method"] | null {
        return this.envelope?.method ?? null;
    }

    getUnlocked(): UnlockedSecret | null {
        return this.unlocked;
    }

    /**
     * AES-GCM key for metadata-at-rest encryption (contacts, bridge claims).
     * Derived lazily from the unlocked seed; dropped on lock. Throws if locked.
     */
    getMetaKey(): Promise<CryptoKey> {
        if (!this.unlocked) throw new Error("Wallet is locked.");
        if (!this.metaKeyPromise) {
            this.metaKeyPromise = deriveMetaKey(this.unlocked.seed);
        }
        return this.metaKeyPromise;
    }

    lock(): void {
        // Zero the seed bytes before dropping the reference, and drop the
        // cached session unlock — an explicit lock requires the password again.
        if (this.unlocked) this.unlocked.seed.fill(0);
        this.unlocked = null;
        this.metaKeyPromise = null;
        this.clearSession();
    }

    private assertSupportedVersion(env: VaultEnvelope): void {
        if (!Number.isInteger(env.v) || env.v < 1) {
            throw new Error("Stored vault data is corrupted (missing version).");
        }
        if (env.v > VAULT_VERSION) {
            throw new Error(
                `This vault was created by a newer version of the wallet (vault v${env.v}, ` +
                    `supported up to v${VAULT_VERSION}). Update the extension to unlock it.`,
            );
        }
        if (RETIRED_VAULT_VERSIONS.has(env.v)) {
            throw new Error(
                `This vault uses a retired legacy format (v${env.v}). ` +
                    `Restore from your 12-word recovery phrase instead.`,
            );
        }
    }

    /**
     * Create a fresh vault from a recovery phrase, gated by either a passkey
     * (preferred) or a passphrase.
     */
    async createWithPasskey(mnemonic: string, userLabel: string): Promise<void> {
        const { credentialId, prfSalt, contentKey } = await registerPasskey(userLabel);
        const ptBytes = new TextEncoder().encode(mnemonic);
        try {
            const key = await importContentKey(contentKey);
            const aad = vaultAAD({ v: VAULT_VERSION, method: "passkey", credentialId, prfSalt });
            const blob = await encrypt(key, ptBytes, aad);
            const env: VaultEnvelope = {
                v: VAULT_VERSION,
                method: "passkey",
                credentialId,
                prfSalt,
                blob,
            };
            await storage.set(KEYS.vault, env);
            this.envelope = env;
        } finally {
            contentKey.fill(0);
            ptBytes.fill(0);
        }
        this.unlocked = { seed: mnemonicToSeed(mnemonic) };
        void this.persistSession();
    }

    async createWithPassphrase(mnemonic: string, passphrase: string): Promise<void> {
        // Enforced here too (not just in the UI) so the strength bar can't be
        // bypassed by a caller. The vault ciphertext is offline-attackable, so a
        // weak passphrase is the weakest link.
        if (!isAcceptablePassphrase(passphrase)) {
            throw new Error(
                "Passphrase is too weak. Use at least 12 characters with a mix of letter case, " +
                    "numbers and symbols — or a longer passphrase.",
            );
        }
        const salt = randomSalt();
        const saltB64 = b64.encode(salt);
        const kdf = ARGON2_DEFAULTS;
        const key = await deriveKeyFromPassphrase(passphrase, salt, kdf);
        const aad = vaultAAD({ v: VAULT_VERSION, method: "passphrase", salt: saltB64, kdf });
        const ptBytes = new TextEncoder().encode(mnemonic);
        try {
            const blob = await encrypt(key, ptBytes, aad);
            const env: VaultEnvelope = {
                v: VAULT_VERSION,
                method: "passphrase",
                salt: saltB64,
                kdf,
                blob,
            };
            await storage.set(KEYS.vault, env);
            this.envelope = env;
        } finally {
            ptBytes.fill(0);
        }
        this.unlocked = { seed: mnemonicToSeed(mnemonic) };
        void this.persistSession();
    }

    async unlockWithPasskey(): Promise<RevealedSecret> {
        if (!this.envelope || this.envelope.method !== "passkey") {
            throw new Error("Vault is not configured for passkey unlock.");
        }
        this.assertSupportedVersion(this.envelope);
        if (!this.envelope.credentialId || !this.envelope.prfSalt) {
            throw new Error("Vault envelope is missing passkey metadata.");
        }
        const contentKey = await unlockWithPasskey(
            this.envelope.credentialId,
            this.envelope.prfSalt,
        );
        try {
            const key = await importContentKey(contentKey);
            let pt: Uint8Array;
            try {
                pt = await decrypt(key, this.envelope.blob, vaultAAD(this.envelope));
            } catch (err) {
                throw decryptFailure(err);
            }
            const mnemonic = new TextDecoder().decode(pt);
            pt.fill(0); // wipe the decrypted plaintext bytes (the string is all that's left)
            this.unlocked = { seed: mnemonicToSeed(mnemonic) };
        void this.persistSession();
            return { mnemonic, seed: this.unlocked.seed };
        } finally {
            // Always wipe the raw AES key, including on decrypt failure.
            contentKey.fill(0);
        }
    }

    async unlockWithPassphrase(passphrase: string): Promise<RevealedSecret> {
        if (!this.envelope || this.envelope.method !== "passphrase") {
            throw new Error("Vault is not configured for passphrase unlock.");
        }
        this.assertSupportedVersion(this.envelope);
        if (!this.envelope.salt) {
            throw new Error("Vault envelope is missing salt.");
        }
        let pt: Uint8Array;
        try {
            // Decode salt INSIDE the try so a tampered/non-base64 salt surfaces
            // the same neutral failure as any other corruption (no raw
            // DOMException leaking past the friendly wrapper, no oracle).
            const salt = b64.decode(this.envelope.salt);
            const key = await deriveKeyFromPassphrase(
                passphrase,
                salt,
                this.envelope.kdf ?? ARGON2_DEFAULTS,
            );
            pt = await decrypt(key, this.envelope.blob, vaultAAD(this.envelope));
        } catch (err) {
            // Legacy fallback: a vault created BEFORE NFKC normalization keyed on
            // the RAW passphrase bytes. For an ASCII passphrase NFKC is identity,
            // so this never runs; for a pre-existing NON-ASCII passphrase, retry
            // with raw bytes so introducing normalization can't brick an existing
            // vault. (Only this failure path pays the second Argon2 derivation.)
            try {
                const salt = b64.decode(this.envelope.salt);
                const rawKey = await deriveKeyFromPassphrase(
                    passphrase,
                    salt,
                    this.envelope.kdf ?? ARGON2_DEFAULTS,
                    false,
                );
                pt = await decrypt(rawKey, this.envelope.blob, vaultAAD(this.envelope));
            } catch {
                throw decryptFailure(err);
            }
        }
        const mnemonic = new TextDecoder().decode(pt);
        pt.fill(0); // wipe the decrypted plaintext bytes
        this.unlocked = { seed: mnemonicToSeed(mnemonic) };
        void this.persistSession();
        return { mnemonic, seed: this.unlocked.seed };
    }

    /**
     * Wipe the vault entirely. Caller is responsible for confirming with the user
     * — there is no recovery from this without the original 12-word phrase.
     */
    async destroy(): Promise<void> {
        await storage.remove(KEYS.vault);
        await storage.remove(KEYS.accountMeta);
        this.envelope = undefined;
        if (this.unlocked) this.unlocked.seed.fill(0);
        this.unlocked = null;
        this.metaKeyPromise = null;
        this.clearSession();
    }
}

export const vaultStore = new VaultStore();
