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
import { deriveL1Key, type L1KeyMaterial } from "./l1Account";
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
    private l1Key: L1KeyMaterial | null = null;

    async init(): Promise<void> {
        this.envelope = await storage.get<VaultEnvelope>(KEYS.vault);
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

    /**
     * The in-wallet L1 funding key (BIP-44 m/44'/60'/0'/0/0 — restorable from
     * the same phrase in any Ethereum wallet). Set at unlock/create; zeroed on
     * lock. Throws while locked.
     */
    getL1Key(): L1KeyMaterial {
        if (!this.l1Key) throw new Error("Wallet is locked.");
        return this.l1Key;
    }

    private setL1Key(mnemonic: string): void {
        if (this.l1Key) this.l1Key.privateKey.fill(0);
        this.l1Key = deriveL1Key(mnemonic);
    }

    lock(): void {
        // Zero the seed bytes before dropping the reference.
        if (this.unlocked) this.unlocked.seed.fill(0);
        this.unlocked = null;
        this.metaKeyPromise = null;
        if (this.l1Key) this.l1Key.privateKey.fill(0);
        this.l1Key = null;
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
        // v1 envelopes predate the public release; no migration path required.
        if (env.v < VAULT_VERSION) {
            throw new Error(
                `This vault uses an unsupported legacy format (v${env.v}). ` +
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
        try {
            const key = await importContentKey(contentKey);
            const aad = vaultAAD({ v: VAULT_VERSION, method: "passkey", credentialId, prfSalt });
            const blob = await encrypt(key, new TextEncoder().encode(mnemonic), aad);
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
        }
        this.unlocked = { seed: mnemonicToSeed(mnemonic) };
        this.setL1Key(mnemonic);
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
        const blob = await encrypt(key, new TextEncoder().encode(mnemonic), aad);
        const env: VaultEnvelope = {
            v: VAULT_VERSION,
            method: "passphrase",
            salt: saltB64,
            kdf,
            blob,
        };
        await storage.set(KEYS.vault, env);
        this.envelope = env;
        this.unlocked = { seed: mnemonicToSeed(mnemonic) };
        this.setL1Key(mnemonic);
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
            this.unlocked = { seed: mnemonicToSeed(mnemonic) };
            this.setL1Key(mnemonic);
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
        const salt = b64.decode(this.envelope.salt);
        const key = await deriveKeyFromPassphrase(
            passphrase,
            salt,
            this.envelope.kdf ?? ARGON2_DEFAULTS,
        );
        let pt: Uint8Array;
        try {
            pt = await decrypt(key, this.envelope.blob, vaultAAD(this.envelope));
        } catch (err) {
            throw decryptFailure(err);
        }
        const mnemonic = new TextDecoder().decode(pt);
        this.unlocked = { seed: mnemonicToSeed(mnemonic) };
        this.setL1Key(mnemonic);
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
        if (this.l1Key) this.l1Key.privateKey.fill(0);
        this.l1Key = null;
    }
}

export const vaultStore = new VaultStore();
