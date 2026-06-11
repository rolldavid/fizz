/**
 * Thin wrapper over chrome.storage.local. We use it for non-secret app state
 * (selected network, token list, vault ciphertext envelope).
 *
 * The vault ciphertext is safe to store here because it's encrypted under a key
 * that is itself wrapped by the WebAuthn PRF output or a key derived from the
 * user's passphrase — neither of which sits in extension storage.
 */
export const storage = {
    async get<T>(key: string): Promise<T | undefined> {
        const out = await chrome.storage.local.get(key);
        return out[key] as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
        await chrome.storage.local.set({ [key]: value });
    },
    async remove(key: string): Promise<void> {
        await chrome.storage.local.remove(key);
    },
};

export const KEYS = {
    vault: "aztec.vault.v1",
    network: "aztec.network.v1",
    customNode: "aztec.customNode.v1",
    tokens: "aztec.tokens.v1",
    accountMeta: "aztec.accountMeta.v1",
    /** Multi-account metadata (count, active index, labels) — encrypted at rest. */
    accountsMeta: "aztec.accountsMeta.v2",
    pendingBridges: "aztec.bridges.pending.v1",
    // Account-deployment txs journaled at broadcast, so an interrupted session
    // resumes the SAME deploy instead of proving a doomed duplicate.
    pendingAccountDeploys: "aztec.accountDeploys.pending.v1",
    contactsPrefix: "aztec.contacts.v1",
    // Addresses you've sent to — the broad "known sender" set used for private
    // note discovery, distinct from named contacts. Per-network.
    knownSendersPrefix: "aztec.senders.v1",
    // Whether the first-run "private vs public" explainer has been dismissed.
    homeIntroSeen: "aztec.home.intro.v1",
} as const;
