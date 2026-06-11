/**
 * Symmetric vault crypto: AES-GCM over a 256-bit content key.
 *
 * Content key is either:
 *   - derived from a passphrase via Argon2id (memory-hard KDF), or
 *   - the WebAuthn PRF output (passkey login).
 *
 * Both paths land at the same 32-byte key that decrypts the vault blob.
 */

import { argon2idAsync } from "@noble/hashes/argon2";

const SUBTLE = globalThis.crypto.subtle;

/** Bump when the envelope format or KDF changes. Bound into the AES-GCM AAD. */
export const VAULT_VERSION = 2;

/**
 * Argon2id parameters for the passphrase KDF. Memory-hard, so the on-disk vault
 * ciphertext is far costlier to brute-force offline than PBKDF2 (which is cheap
 * to parallelize on GPUs/ASICs). 128 MiB / t=3 / p=1 is a few seconds per guess
 * on a laptop and well above the OWASP Argon2id floor — a deliberate hardening
 * over the prior 64 MiB, since the vault blob is offline-attackable. The params
 * are stored per-vault in the envelope and bound into the AAD, so this raise is
 * NON-BRICKING (existing vaults decrypt with their own stored params) and can't
 * be silently downgraded.
 */
export type Argon2Params = { algo: "argon2id"; m: number; t: number; p: number };
export const ARGON2_DEFAULTS: Argon2Params = { algo: "argon2id", m: 131_072, t: 3, p: 1 };

export type VaultBlob = {
    /** Base64 nonce */
    iv: string;
    /** Base64 ciphertext */
    ct: string;
};

export type VaultEnvelope = {
    /** Envelope format version. */
    v: number;
    /**
     * "passkey" — content key was derived from WebAuthn PRF.
     * "passphrase" — content key was derived from a user passphrase via PBKDF2.
     */
    method: "passkey" | "passphrase";
    /** Argon2id salt (base64). Only present when method === "passphrase". */
    salt?: string;
    /**
     * The credential id of the passkey. Only present when method === "passkey".
     * We need this to ask the authenticator to evaluate PRF with the same input.
     */
    credentialId?: string;
    /** The PRF salt (base64). Only present when method === "passkey". */
    prfSalt?: string;
    /** Argon2id KDF params. Only present when method === "passphrase". */
    kdf?: Argon2Params;
    /** Ciphertext of the secret payload. */
    blob: VaultBlob;
};

/**
 * Associated data bound into AES-GCM. Authenticating the key-selecting metadata
 * (version, method, salt/credentialId/prfSalt) prevents an attacker with write
 * access to chrome.storage.local from swapping those plaintext fields (e.g.
 * downgrading method or substituting a salt) without invalidating the tag. The
 * serialization must be byte-identical at encrypt and decrypt time, so the key
 * order here is fixed and load-bearing.
 *
 * The version bound here is the ENVELOPE'S OWN version (`meta.v`), never the
 * module constant — otherwise bumping VAULT_VERSION for new vaults would change
 * the AAD recomputed at decrypt time for OLD vaults and brick every one of them
 * with what looks like a wrong-passphrase error. Encrypt paths pass
 * `v: VAULT_VERSION` explicitly for newly created envelopes; decrypt paths pass
 * the stored envelope (whose `v` is whatever it was created with).
 */
export function vaultAAD(
    meta: Pick<VaultEnvelope, "v" | "method" | "salt" | "credentialId" | "prfSalt" | "kdf">,
): Uint8Array {
    if (!Number.isInteger(meta.v) || meta.v < 1) {
        throw new Error(`Vault envelope has an invalid version: ${meta.v}`);
    }
    return new TextEncoder().encode(
        JSON.stringify({
            v: meta.v,
            method: meta.method,
            salt: meta.salt ?? null,
            credentialId: meta.credentialId ?? null,
            prfSalt: meta.prfSalt ?? null,
            kdf: meta.kdf ?? null,
        }),
    );
}

function toB64(bytes: ArrayBuffer | Uint8Array): string {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (const b of arr) s += String.fromCharCode(b);
    return btoa(s);
}

function fromB64(b64: string): Uint8Array {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

export const b64 = { encode: toB64, decode: fromB64 };

export async function importContentKey(raw: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
    const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (buf.byteLength !== 32) {
        throw new Error(`Vault content key must be 32 bytes, got ${buf.byteLength}`);
    }
    return SUBTLE.importKey("raw", buf, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function deriveKeyFromPassphrase(
    passphrase: string,
    salt: Uint8Array,
    params: Argon2Params = ARGON2_DEFAULTS,
): Promise<CryptoKey> {
    // argon2idAsync yields to the event loop (asyncTick) so the popup spinner
    // keeps animating during the ~1.5s derivation instead of freezing.
    const pw = new TextEncoder().encode(passphrase);
    let raw: Uint8Array;
    try {
        raw = await argon2idAsync(pw, salt, {
            t: params.t,
            m: params.m,
            p: params.p,
            dkLen: 32,
            asyncTick: 20,
        });
    } finally {
        // Wipe the passphrase bytes even if Argon2 throws — the un-wipeable
        // source string is all that should survive this call.
        pw.fill(0);
    }
    try {
        return await importContentKey(raw);
    } finally {
        raw.fill(0);
    }
}

export async function encrypt(
    key: CryptoKey,
    plaintext: Uint8Array,
    additionalData?: Uint8Array,
): Promise<VaultBlob> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const params: AesGcmParams = { name: "AES-GCM", iv };
    if (additionalData) params.additionalData = additionalData;
    const ct = await SUBTLE.encrypt(params, key, plaintext);
    return { iv: toB64(iv), ct: toB64(ct) };
}

export async function decrypt(
    key: CryptoKey,
    blob: VaultBlob,
    additionalData?: Uint8Array,
): Promise<Uint8Array> {
    const iv = fromB64(blob.iv);
    const ct = fromB64(blob.ct);
    const params: AesGcmParams = { name: "AES-GCM", iv };
    if (additionalData) params.additionalData = additionalData;
    const pt = await SUBTLE.decrypt(params, key, ct);
    return new Uint8Array(pt);
}

export function randomSalt(length = 16): Uint8Array {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
