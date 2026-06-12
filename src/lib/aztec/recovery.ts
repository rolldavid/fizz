/**
 * Local-sync recovery.
 *
 * The in-browser PXE keeps its synced chain/private state in IndexedDB
 * (`pxe_data_<rollup>` + the embedded wallet DB `wallet_data_<rollup>`). If that
 * store goes stale or is damaged (e.g. an earlier IndexedDB write fault), the
 * wallet can anchor transactions to a block the node no longer recognizes —
 * surfacing as "Block header not found" on send. Wiping it forces a clean
 * re-sync from chain.
 *
 * SAFE: nothing irreplaceable lives here. The mnemonic vault, contacts, and
 * bridge-claim secrets are in chrome.storage (encrypted, untouched); account
 * keys derive from the seed; private notes re-sync from chain via the registered
 * accounts/senders. This is a sync-cache reset, NOT a wallet wipe.
 */

/** Delete the PXE + embedded-wallet IndexedDB stores. Best-effort per database. */
export async function resetLocalSyncData(): Promise<string[]> {
    const idb = globalThis.indexedDB;
    if (!idb) throw new Error("IndexedDB is unavailable in this context.");

    let names: string[] = [];
    if (typeof (idb as IDBFactory & { databases?: () => Promise<IDBDatabaseInfo[]> }).databases === "function") {
        const infos = await idb.databases();
        names = infos.map((i) => i.name).filter((n): n is string => typeof n === "string");
    }
    // Only the PXE sync caches — never anything else.
    const targets = names.filter((n) => /^(pxe_data_|wallet_data_)/.test(n));

    await Promise.all(
        targets.map(
            (name) =>
                new Promise<void>((resolve) => {
                    const req = idb.deleteDatabase(name);
                    req.onsuccess = () => resolve();
                    req.onerror = () => resolve(); // best-effort — surface nothing fatal
                    req.onblocked = () => resolve(); // open elsewhere; will clear on reload
                }),
        ),
    );
    return targets;
}
