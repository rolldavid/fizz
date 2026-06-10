/**
 * Metadata-at-rest encryption.
 *
 * The vault encrypts the mnemonic, but the wallet's OTHER local state — the
 * counterparty graph (contacts, known senders) and bridge claim secrets
 * (spendable!) — used to sit in chrome.storage.local as plaintext. Anyone with
 * profile-disk access (malware, seizure, backup exfiltration) could read who
 * you transact with and redeem pending fee-juice claims.
 *
 * This module derives a dedicated AES-GCM key from the unlocked 32-byte seed
 * via HKDF-SHA256 with a fixed domain-separation info string. Properties:
 *   - deterministic per seed (survives reinstalls/restores from phrase)
 *   - independent of the vault content key (compromise of one reveals nothing
 *     about the other; HKDF is one-way from the seed)
 *   - non-extractable CryptoKey, dropped on lock.
 */

const HKDF_INFO = "aztec-wallet/meta-key/v1";

export async function deriveMetaKey(seed: Uint8Array): Promise<CryptoKey> {
    if (seed.length !== 32) throw new Error(`Meta key derivation needs a 32-byte seed, got ${seed.length}.`);
    const ikm = await crypto.subtle.importKey("raw", seed as BufferSource, "HKDF", false, [
        "deriveKey",
    ]);
    return crypto.subtle.deriveKey(
        {
            name: "HKDF",
            hash: "SHA-256",
            // Fixed all-zero salt is fine for HKDF with a uniformly random IKM;
            // domain separation comes from `info`.
            salt: new Uint8Array(32),
            info: new TextEncoder().encode(HKDF_INFO),
        },
        ikm,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
}

export type EncBlob = {
    /**
     * Format version for encrypted-at-rest values:
     *   1 — no AAD (legacy; read-only for migration).
     *   2 — AES-GCM AAD binds the storage key, so ciphertext from one storage
     *       key can't be substituted onto another (the meta-key is the same for
     *       all of them) and a rollback to an old value is detectable.
     */
    __enc: 1 | 2;
    /** base64 12-byte IV */
    iv: string;
    /** base64 ciphertext (AES-256-GCM) */
    ct: string;
};

export function isEncBlob(v: unknown): v is EncBlob {
    return (
        typeof v === "object" &&
        v !== null &&
        ((v as any).__enc === 1 || (v as any).__enc === 2) &&
        typeof (v as any).iv === "string" &&
        typeof (v as any).ct === "string"
    );
}

/** AAD for a v2 blob: binds the storage key (+ a small format epoch). */
function metaAAD(storageKey: string): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ k: storageKey, ev: 1 }));
}

function toB64(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}
function fromB64(b64: string): Uint8Array {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

export async function encryptJson(key: CryptoKey, value: unknown, storageKey: string): Promise<EncBlob> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode(JSON.stringify(value));
    const ct = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: metaAAD(storageKey) as BufferSource },
            key,
            pt,
        ),
    );
    pt.fill(0);
    return { __enc: 2, iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJson<T>(key: CryptoKey, blob: EncBlob, storageKey: string): Promise<T> {
    // v1 blobs were written without AAD; decrypt them unbound (migration only —
    // secureStorage re-writes them as v2 on read). v2 binds the storage key.
    const params: AesGcmParams = { name: "AES-GCM", iv: fromB64(blob.iv) as BufferSource };
    if (blob.__enc === 2) params.additionalData = metaAAD(storageKey) as BufferSource;
    const pt = await crypto.subtle.decrypt(params, key, fromB64(blob.ct) as BufferSource);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(pt))) as T;
}
