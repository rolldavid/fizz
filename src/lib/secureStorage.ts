/**
 * Encrypted-at-rest wrapper over chrome.storage.local for SENSITIVE metadata
 * (contacts, known senders, bridge claim secrets). See vault/metaCrypto.ts for
 * the key design.
 *
 * The key arrives via an injected provider (set by the wallet context after
 * unlock, or by tests) so this module doesn't hard-couple lib/aztec to the
 * vault singleton. Reads of legacy PLAINTEXT values still succeed and are
 * transparently re-written encrypted — a one-time migration per key.
 *
 * All operations require the wallet to be unlocked; calling while locked is a
 * bug and throws loudly (no silent plaintext fallback — ever).
 */

import { storage } from "./storage";
import { decryptJson, encryptJson, isEncBlob } from "./vault/metaCrypto";

let metaKeyProvider: (() => Promise<CryptoKey>) | null = null;

export function setMetaKeyProvider(provider: (() => Promise<CryptoKey>) | null): void {
    metaKeyProvider = provider;
}

async function requireKey(): Promise<CryptoKey> {
    if (!metaKeyProvider) {
        throw new Error("Encrypted storage unavailable — the wallet is locked.");
    }
    return metaKeyProvider();
}

export async function secureGet<T>(key: string): Promise<T | undefined> {
    const raw = await storage.get<unknown>(key);
    if (raw === undefined) return undefined;
    if (isEncBlob(raw)) {
        return decryptJson<T>(await requireKey(), raw);
    }
    // Legacy plaintext value: migrate to encrypted in place, then return it.
    const k = await requireKey();
    await storage.set(key, await encryptJson(k, raw));
    return raw as T;
}

export async function secureSet<T>(key: string, value: T): Promise<void> {
    const k = await requireKey();
    await storage.set(key, await encryptJson(k, value));
}

export async function secureRemove(key: string): Promise<void> {
    await storage.remove(key);
}
