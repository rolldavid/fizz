/**
 * In-memory stub of the chrome.storage.local API surface used by src/lib.
 * Lets the REAL wallet modules (storage.ts, tokens.ts, contacts.ts, bridge.ts,
 * vault/store.ts) run unmodified under Node/vitest.
 *
 * Mirrors MV3 promise semantics for the calls the wallet makes:
 *   get(key: string)  -> Promise<{ [key]: value }>
 *   set(obj)          -> Promise<void>
 *   remove(key)       -> Promise<void>
 */

const mem = new Map<string, unknown>();

export function resetChromeStorage(): void {
    mem.clear();
}

export function chromeStorageSnapshot(): Record<string, unknown> {
    return Object.fromEntries(mem.entries());
}

function structuredCloneish<T>(v: T): T {
    // chrome.storage round-trips through structured clone; emulate so tests
    // catch accidental storage of non-serializable values (functions, Fr, etc.)
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

const local = {
    async get(key: string | string[] | Record<string, unknown> | null) {
        if (key === null || key === undefined) {
            return Object.fromEntries(mem.entries());
        }
        if (typeof key === "string") {
            return mem.has(key) ? { [key]: structuredCloneish(mem.get(key)) } : {};
        }
        if (Array.isArray(key)) {
            const out: Record<string, unknown> = {};
            for (const k of key) if (mem.has(k)) out[k] = structuredCloneish(mem.get(k));
            return out;
        }
        throw new Error("chrome-stub: unsupported get() arg shape");
    },
    async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) {
            if (v === undefined) {
                throw new Error(`chrome-stub: refusing to store undefined for key ${k}`);
            }
            mem.set(k, structuredCloneish(v));
        }
    },
    async remove(key: string | string[]) {
        for (const k of Array.isArray(key) ? key : [key]) mem.delete(k);
    },
};

(globalThis as any).chrome = {
    ...(globalThis as any).chrome,
    storage: { local },
};

// Sensitive metadata (contacts, known senders, bridge claims) is encrypted at
// rest; in the app the key comes from the unlocked vault. Tests install a
// static session key so the real encryption path runs end-to-end.
import { setMetaKeyProvider } from "../../src/lib/secureStorage";

const testMetaKey = crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
]);
setMetaKeyProvider(() => testMetaKey);
