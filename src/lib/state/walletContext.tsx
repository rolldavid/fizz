import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { ContractInitializationStatus } from "@aztec/aztec.js/wallet";
import { vaultStore, type UnlockedSecret } from "../vault/store";
import {
    DEFAULT_NETWORK_ID,
    SELECTABLE_NETWORK_IDS,
    SELECTABLE_NETWORKS,
    getNetwork,
    resolveNetwork,
    type AztecNetwork,
} from "../aztec/networks";
import { KEYS, storage } from "../storage";
import {
    createBrowserWallet,
    deployAccountContract,
    deriveAccount,
    type AztecWallet,
} from "../aztec/wallet";
import { markFeeConsumed, releaseFee, resolveFeePaymentMethod } from "../aztec/fee";
import {
    clearPendingDeploy,
    loadPendingDeploy,
    recordPendingDeploy,
    settlePriorDeploy,
} from "../aztec/accountDeploy";
import { markBridgeConsumed } from "../aztec/bridge";
import { getTokenBalance } from "../aztec/balances";
import { FEE_JUICE_ENTRY } from "../aztec/tokens";
import { syncContactsToPxe, syncKnownSendersToPxe } from "../aztec/contacts";
import { secureGet, secureSet, setMetaKeyProvider } from "../secureStorage";
import { hasActiveOps, trackOp } from "./activity";
import { drainClaimInbox } from "../aztec/claimInbox";
import { autoClaimTick } from "../aztec/autoClaim";
import { describeError } from "../errors";
import { withPxeLock } from "../aztec/pxeLock";

type AccountManager = Awaited<ReturnType<AztecWallet["createSchnorrAccount"]>>;

type Status = "uninitialized" | "locked" | "unlocking" | "loading" | "ready";

/** Re-lock the wallet after this much user inactivity while unlocked. */
const IDLE_LOCK_MS = 5 * 60_000;

/**
 * Absolute ceiling on how long the idle auto-lock may be DEFERRED by an
 * in-flight tracked op, measured from the last user interaction. A tracked op
 * awaits node-driven tx inclusion over an RPC fetch with no timeout, so a
 * malicious or unresponsive node can hold it open forever — which would
 * otherwise re-arm the idle window indefinitely and keep the decrypted seed
 * resident in memory + session cache past the idle policy, defeating the
 * control for a later local attacker. Past this ceiling we lock regardless of
 * active ops (tearing down an op that has clearly hung).
 */
const MAX_IDLE_DEFERRAL_MS = 20 * 60_000;

export type Account = {
    address: AztecAddress;
    isDeployed: boolean;
    /** Derivation index under DERIVATION_VERSION 1. */
    index: number;
    label: string;
};

export type AccountListEntry = {
    index: number;
    label: string;
    address: AztecAddress;
};

/** Persisted (encrypted) multi-account metadata. */
type AccountsMeta = {
    count: number;
    activeIndex: number;
    labels: Record<number, string>;
    /**
     * Indices the user removed from the wallet UI. Accounts are deterministic
     * derivations, so "remove" can only ever mean HIDE: the keys remain
     * derivable from the seed and any funds stay on-chain. "+ New account"
     * restores the lowest hidden index first, so nothing is ever stranded.
     */
    hidden?: number[];
};

const DEFAULT_ACCOUNTS_META: AccountsMeta = { count: 1, activeIndex: 0, labels: {} };
const MAX_ACCOUNTS = 16;

/** Indices currently shown in the wallet (derivation order, minus hidden). */
function visibleIndices(meta: AccountsMeta): number[] {
    const hidden = meta.hidden ?? [];
    return Array.from({ length: meta.count }, (_, i) => i).filter((i) => !hidden.includes(i));
}

type Ctx = {
    status: Status;
    network: AztecNetwork;
    networks: AztecNetwork[];
    setNetwork: (id: AztecNetwork["id"]) => Promise<void>;

    account: Account | null;
    /** All derived accounts registered in this wallet's PXE, in index order. */
    accounts: AccountListEntry[];
    /** Switch the active account (instant — all accounts share the PXE). */
    switchAccount: (index: number) => Promise<void>;
    /** Derive + register the next account index and switch to it. */
    addAccount: (label?: string) => Promise<void>;
    renameAccount: (index: number, label: string) => Promise<void>;
    /** Hide an account from the wallet (keys/funds untouched; restorable). */
    removeAccount: (index: number) => Promise<void>;
    wallet: AztecWallet | null;

    bootError: string | null;
    retryBoot: () => Promise<void>;

    /**
     * Publish + initialize the account contract on-chain if it isn't yet.
     * MUST be awaited before the account's first transaction — an undeployed
     * account cannot send. Pays via the resolved fee method (bridge claim or
     * sponsored FPC); throws if neither is available and the account holds no
     * fee juice. Idempotent and single-flight.
     */
    ensureAccountDeployed: () => Promise<void>;

    onboardingMethod: "passkey" | "passphrase" | null;

    unlockWithPasskey: () => Promise<void>;
    unlockWithPassphrase: (passphrase: string) => Promise<void>;

    createAccountWithPasskey: (mnemonic: string, label: string) => Promise<void>;
    createAccountWithPassphrase: (mnemonic: string, passphrase: string) => Promise<void>;

    lock: () => void;
    destroy: () => Promise<void>;
};

const WalletCtx = createContext<Ctx | null>(null);

async function loadNetwork(): Promise<AztecNetwork> {
    const stored = await storage.get<AztecNetwork["id"]>(KEYS.network);
    // Only the picker's networks are valid selections now; a stale sandbox/custom
    // selection from an older build falls back to the default (Mainnet).
    const id = stored && SELECTABLE_NETWORK_IDS.includes(stored) ? stored : DEFAULT_NETWORK_ID;
    try {
        return await resolveNetwork(id);
    } catch {
        return getNetwork(DEFAULT_NETWORK_ID);
    }
}

async function loadAccountsMeta(): Promise<AccountsMeta> {
    const stored = await secureGet<AccountsMeta>(KEYS.accountsMeta);
    if (!stored || !Number.isInteger(stored.count) || stored.count < 1) {
        return DEFAULT_ACCOUNTS_META;
    }
    const count = Math.min(stored.count, MAX_ACCOUNTS);
    // Sanitize hidden: in-range only, and NEVER all of them — a meta that
    // hides every account would brick the wallet, so it falls back to none.
    let hidden = (stored.hidden ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < count);
    if (hidden.length >= count) hidden = [];
    const visible = Array.from({ length: count }, (_, i) => i).filter((i) => !hidden.includes(i));
    let activeIndex = Math.min(Math.max(stored.activeIndex ?? 0, 0), count - 1);
    if (!visible.includes(activeIndex)) activeIndex = visible[0];
    return {
        count,
        activeIndex,
        labels: stored.labels ?? {},
        hidden,
    };
}

function accountLabel(meta: AccountsMeta, index: number): string {
    return meta.labels[index]?.trim() || `Account ${index + 1}`;
}

/** Check deployment (initialization) status of one address. */
async function isInitialized(wallet: AztecWallet, address: AztecAddress): Promise<boolean> {
    const meta = await wallet.getContractMetadata(address);
    // The account contract is "deployed" only once its initialization nullifier
    // exists (status INITIALIZED). UNINITIALIZED (brand-new) and UNKNOWN (not
    // registered / can't tell) must both be treated as NOT deployed — the enum
    // values are uppercase, so a lowercase comparison would report every
    // account as deployed and hide the "deploys on first tx" state.
    return meta.initializationStatus === ContractInitializationStatus.INITIALIZED;
}

async function bootWallet(
    network: AztecNetwork,
    secret: UnlockedSecret,
): Promise<{
    wallet: AztecWallet;
    account: Account;
    accounts: AccountListEntry[];
    managers: Map<number, AccountManager>;
    meta: AccountsMeta;
}> {
    const wallet = await createBrowserWallet(network);
    const meta = await loadAccountsMeta();

    // Register every VISIBLE account in the PXE so notes for all of them are
    // discovered continuously; only the active one drives the UI. Hidden
    // (removed) indices are skipped entirely — not derived, not synced.
    const managers = new Map<number, AccountManager>();
    const accounts: AccountListEntry[] = [];
    for (const i of visibleIndices(meta)) {
        const { secret: accSecret, salt } = await deriveAccount(secret.seed, i);
        const label = accountLabel(meta, i);
        const manager = await wallet.createSchnorrAccount(accSecret, salt, undefined, label);
        managers.set(i, manager);
        accounts.push({ index: i, label, address: manager.address });
    }

    const active = managers.get(meta.activeIndex);
    if (!active) throw new Error(`Active account index ${meta.activeIndex} failed to derive.`);
    const isDeployed = await isInitialized(wallet, active.address);
    return {
        wallet,
        account: {
            address: active.address,
            isDeployed,
            index: meta.activeIndex,
            label: accountLabel(meta, meta.activeIndex),
        },
        accounts,
        managers,
        meta,
    };
}

export function WalletProvider({ children }: { children: ReactNode }) {
    const [status, setStatus] = useState<Status>("locked");
    const [network, setNetworkState] = useState<AztecNetwork>(getNetwork(DEFAULT_NETWORK_ID));
    const [wallet, setWallet] = useState<AztecWallet | null>(null);
    const [account, setAccount] = useState<Account | null>(null);
    const [accounts, setAccounts] = useState<AccountListEntry[]>([]);
    const [bootError, setBootError] = useState<string | null>(null);
    const networkRef = useRef(network);
    // The live wallet/PXE instance. Tracked separately from React state so we can
    // tear it down (stop its sync loop + close its IndexedDB connection) before
    // creating a replacement on network-switch / re-unlock — otherwise the old
    // PXE keeps syncing and races the new one on the same database.
    const walletInstanceRef = useRef<AztecWallet | null>(null);
    const managersRef = useRef<Map<number, AccountManager>>(new Map());
    const accountsMetaRef = useRef<AccountsMeta>(DEFAULT_ACCOUNTS_META);
    const activeIndexRef = useRef(0);
    // Single-flight guard so two concurrent sends can't double-deploy.
    const deployInFlightRef = useRef<Promise<void> | null>(null);

    useEffect(() => {
        networkRef.current = network;
    }, [network]);

    const stopCurrentWallet = useCallback(async () => {
        const prev = walletInstanceRef.current;
        walletInstanceRef.current = null;
        managersRef.current = new Map();
        if (!prev) return;
        await prev.stop().catch((e) => console.warn("PXE stop failed:", e));
    }, []);

    const handleUnlocked = useCallback(async (net: AztecNetwork, secret: UnlockedSecret) => {
        setStatus("loading");
        setBootError(null);
        // Sensitive metadata (contacts, bridge claims) is encrypted at rest
        // under a seed-derived key — install the provider for this session.
        setMetaKeyProvider(() => vaultStore.getMetaKey());
        // Adopt claim tickets delivered by fizzwallet.com/bridge while we were
        // locked, so a fee claim is usable even if the user goes straight to
        // Send. Best-effort: a corrupt inbox must not block unlock, but it must
        // be VISIBLE (extension console), never silent.
        void drainClaimInbox().catch((err) => console.error("Claim-inbox drain failed:", err));
        // Tear down any previous PXE before standing up a new one.
        await stopCurrentWallet();
        try {
            const { wallet: w, account: a, accounts: list, managers, meta } = await bootWallet(net, secret);
            walletInstanceRef.current = w;
            managersRef.current = managers;
            accountsMetaRef.current = meta;
            activeIndexRef.current = a.index;
            setWallet(w);
            setAccount(a);
            setAccounts(list);
            setStatus("ready");
            // Register the known-sender set (every account's named contacts +
            // everyone they've sent to) into the PXE so incoming private notes
            // are discovered on the fast tagged path. Discovery is wallet-wide
            // (one PXE serves all accounts) even though the lists themselves
            // are per-account. Fire-and-forget so the UI doesn't block.
            const accountAddrs = list.map((a) => a.address.toString());
            // Run the two registerSender sweeps THROUGH the PXE lock and one
            // after the other — never concurrently with each other or with a
            // send/estimate. registerSender → addSender does an IndexedDB
            // read-then-write whose transaction commits early if another PXE op
            // interleaves, throwing "transaction has finished"; serializing the
            // whole sweep closes that window. Still fire-and-forget so the UI
            // doesn't block on a slow address book.
            void withPxeLock(() => syncContactsToPxe(net.id, w, accountAddrs))
                .catch((err) => console.warn("Contact sync failed:", err))
                .then(() =>
                    withPxeLock(() => syncKnownSendersToPxe(net.id, w, accountAddrs)).catch((err) =>
                        console.warn("Known-sender sync failed:", err),
                    ),
                );
        } catch (err) {
            setBootError(describeError(err));
            // Stay in "loading" so the LoadingScreen renders the error/retry UI.
        }
    }, [stopCurrentWallet]);

    // On mount: load the saved network, then either boot straight in from a
    // cached session unlock (vaultStore.init restored the seed from session
    // memory — same browser session, < 30 days), or land on locked/onboarding.
    useEffect(() => {
        loadNetwork().then(async (n) => {
            networkRef.current = n;
            setNetworkState(n);
            const restored = vaultStore.getUnlocked();
            if (restored) {
                await handleUnlocked(n, restored);
            } else {
                setStatus(vaultStore.isInitialized() ? "locked" : "uninitialized");
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const retryBoot = useCallback(async () => {
        const secret = vaultStore.getUnlocked();
        if (!secret) {
            setStatus("locked");
            setBootError(null);
            return;
        }
        await handleUnlocked(networkRef.current, secret);
    }, [handleUnlocked]);

    const ensureAccountDeployed = useCallback(async () => {
        const w = walletInstanceRef.current;
        const manager = managersRef.current.get(activeIndexRef.current);
        if (!w || !manager) throw new Error("Wallet not loaded.");

        // Re-check live status — another popup/tab may have deployed already.
        if (await isInitialized(w, manager.address)) {
            // If the deploy that landed was journaled by a session that died
            // before its receipt, it still owes the claim bookkeeping: the fee
            // consumed a bridge claim that must never be re-offered.
            const landed = await loadPendingDeploy(
                networkRef.current.id,
                manager.address.toString(),
            );
            if (landed) {
                if (landed.bridgeId) await markBridgeConsumed(landed.bridgeId);
                await clearPendingDeploy(landed.network, landed.address);
            }
            setAccount((prev) => (prev ? { ...prev, isDeployed: true } : prev));
            return;
        }

        if (!deployInFlightRef.current) {
            deployInFlightRef.current = trackOp(async () => {
                const net = networkRef.current;
                const addr = manager.address.toString();

                // A deployment broadcast earlier — possibly by a session that
                // died mid-wait — may still be settling. Resume THAT tx instead
                // of proving a duplicate (minutes of proving, doomed by the
                // original's initialization nullifier). Throws while genuinely
                // in flight; returns false only when provably dead.
                const prior = await loadPendingDeploy(net.id, addr);
                if (prior && (await settlePriorDeploy(w, prior))) {
                    setAccount((prev) => (prev ? { ...prev, isDeployed: true } : prev));
                    return;
                }

                const fee = await resolveFeePaymentMethod(w, net, manager.address);
                // Single try from here so the fee-claim spend lock taken above is
                // released on ANY failure before it's consumed — the balance check,
                // the liveness re-check, or the deploy itself — not just a
                // deployAccountContract throw. releaseFee/markFeeConsumed are
                // idempotent, so the early-return release below is safe too.
                try {
                    if (!fee.method) {
                        // No claim and no sponsor — but the account may already
                        // HOLD fee juice (e.g. a prior deploy reverted after its
                        // claim-paid setup landed the balance). method: undefined
                        // means exactly "pay from balance", so only a truly empty
                        // account is an error.
                        const balance = await getTokenBalance(w, manager.address, FEE_JUICE_ENTRY);
                        if (balance.public === 0n) {
                            const guidance =
                                net.id === "sandbox"
                                    ? "Bridge fee juice from the local L1 (Need fee juice?), then try again."
                                    : net.id === "alpha"
                                      ? "Aztec mainnet has no sponsored fees — bridge AZTEC → fee juice on " +
                                        "fizzwallet.com/bridge first (tap “Need fee juice?”), then try again."
                                      : "Use the testnet faucet or bridge fee juice (Need fee juice?), then try again.";
                            throw new Error(
                                net.hasSponsoredFPC
                                    ? "Couldn't resolve a fee payment method to activate the account."
                                    : `Your account needs fee juice before its first transaction. ${guidance}`,
                            );
                        }
                    }
                    // Re-check liveness immediately before the multi-minute
                    // proving+broadcast: a second extension document (detached
                    // window + toolbar popup) could also have passed the earlier
                    // not-deployed check and already deployed. This shrinks the
                    // cross-context TOCTOU window where both would prove and
                    // broadcast a duplicate (only one lands — the init nullifier is
                    // single-use — but the loser wastes minutes of proving).
                    if (await isInitialized(w, manager.address)) {
                        releaseFee(fee); // don't strand the claim we locked
                        const landed = await loadPendingDeploy(net.id, addr);
                        if (landed?.bridgeId) await markBridgeConsumed(landed.bridgeId);
                        if (landed) await clearPendingDeploy(landed.network, landed.address);
                        setAccount((prev) => (prev ? { ...prev, isDeployed: true } : prev));
                        return;
                    }
                    await deployAccountContract({
                        wallet: w,
                        manager,
                        feeMethod: fee.method,
                        // Journal at broadcast so a death during the inclusion wait
                        // resumes this exact tx (and its claim bookkeeping) later.
                        onBroadcast: (txHash) =>
                            recordPendingDeploy({
                                network: net.id,
                                address: addr,
                                txHash,
                                bridgeId: fee.consumesBridgeId,
                                broadcastAt: Date.now(),
                            }),
                    });
                } catch (err) {
                    releaseFee(fee); // any failure before consume — return the claim to the pool
                    throw err;
                }
                await markFeeConsumed(fee);
                await clearPendingDeploy(net.id, addr);
                setAccount((prev) => (prev ? { ...prev, isDeployed: true } : prev));
            }).finally(() => {
                deployInFlightRef.current = null;
            });
        }
        await deployInFlightRef.current;
    }, []);

    // Background fee-juice landing: while the popup is open, a confirmed
    // bridge claim is turned into visible balance automatically — deploying
    // the account first if this is its first gas (the deploy pays itself with
    // the claim). Deliberately invisible: no UI beyond the balance appearing.
    // The 20s cadence is the polling on L1→L2 message availability; ticks
    // before any local pending claim exist cost nothing.
    useEffect(() => {
        if (status !== "ready" || !wallet || !account) return;
        let stopped = false;
        const tick = () => {
            void autoClaimTick({
                wallet,
                network: networkRef.current,
                recipient: account.address,
                isDeployed: account.isDeployed,
                ensureAccountDeployed,
                seed: vaultStore.getUnlocked()?.seed,
                accountIndex: account.index,
            }).catch((err) => {
                // Background path: log loudly (extension console) but never
                // crash the popup. The claim stays usable as a next-tx fee.
                if (!stopped) console.error("Background fee-juice claim failed:", err);
            });
        };
        tick();
        const timer = window.setInterval(tick, 20_000);
        return () => {
            stopped = true;
            window.clearInterval(timer);
        };
    }, [status, wallet, account, ensureAccountDeployed]);

    const persistAccountsMeta = useCallback(async (meta: AccountsMeta) => {
        // Re-read the latest persisted meta and merge field-wise so a concurrent
        // wallet document (detached window + toolbar popup, both unlocked from
        // the shared session cache) can't clobber a change the other committed.
        // Conservative: NEVER reduce the account count — that would silently drop
        // a just-added account from PXE discovery on the next boot — and UNION
        // labels so a rename in one window survives an add in the other. The
        // active index and hidden set follow the action the user just took here.
        const stored = (await secureGet<AccountsMeta>(KEYS.accountsMeta)) ?? meta;
        const merged: AccountsMeta = {
            count: Math.max(meta.count, stored.count),
            activeIndex: meta.activeIndex,
            labels: { ...stored.labels, ...meta.labels },
            hidden: meta.hidden,
        };
        accountsMetaRef.current = merged;
        await secureSet(KEYS.accountsMeta, merged);
    }, []);

    // Keep accountsMetaRef fresh when ANOTHER extension document writes the
    // meta blob, so the NEXT mutation here builds on the current value instead
    // of a stale in-memory base. (Cross-window PXE re-registration of a newly
    // added index is left to the next boot — the merge above ensures the count
    // is never lost, so the account is always discovered on reload.)
    useEffect(() => {
        const onChanged = (
            changes: Record<string, chrome.storage.StorageChange>,
            area: string,
        ) => {
            if (area !== "local" || !(KEYS.accountsMeta in changes)) return;
            void secureGet<AccountsMeta>(KEYS.accountsMeta)
                .then((m) => {
                    if (m) accountsMetaRef.current = m;
                })
                .catch(() => {
                    /* locked or undecryptable — next boot reconciles */
                });
        };
        chrome.storage.onChanged.addListener(onChanged);
        return () => chrome.storage.onChanged.removeListener(onChanged);
    }, []);

    const switchAccount = useCallback(async (index: number) => {
        const w = walletInstanceRef.current;
        const manager = managersRef.current.get(index);
        if (!w || !manager) throw new Error(`No account at index ${index}.`);
        const meta = accountsMetaRef.current;
        await persistAccountsMeta({ ...meta, activeIndex: index });
        activeIndexRef.current = index;
        setAccount({
            address: manager.address,
            isDeployed: await isInitialized(w, manager.address),
            index,
            label: accountLabel(accountsMetaRef.current, index),
        });
    }, [persistAccountsMeta]);

    const addAccount = useCallback(
        async (label?: string) => {
            const w = walletInstanceRef.current;
            const secret = vaultStore.getUnlocked();
            if (!w || !secret) throw new Error("Wallet not loaded.");
            const meta = accountsMetaRef.current;
            const cleanLabel = label?.trim();

            // Restore-first: removed (hidden) indices are the same deterministic
            // derivations, possibly with funds — "new account" brings the lowest
            // one back before minting a fresh index, so nothing stays stranded.
            const hidden = meta.hidden ?? [];
            const restoring = hidden.length > 0 ? Math.min(...hidden) : null;
            if (restoring === null && meta.count >= MAX_ACCOUNTS) {
                throw new Error(`Account limit reached (${MAX_ACCOUNTS}).`);
            }
            const index = restoring ?? meta.count;
            const nextMeta: AccountsMeta = {
                count: restoring !== null ? meta.count : meta.count + 1,
                activeIndex: index,
                labels: cleanLabel ? { ...meta.labels, [index]: cleanLabel } : meta.labels,
                hidden: restoring !== null ? hidden.filter((h) => h !== index) : hidden,
            };
            const { secret: accSecret, salt } = await deriveAccount(secret.seed, index);
            const manager = await w.createSchnorrAccount(
                accSecret,
                salt,
                undefined,
                accountLabel(nextMeta, index),
            );
            managersRef.current.set(index, manager);
            await persistAccountsMeta(nextMeta);
            activeIndexRef.current = index;
            setAccounts((prev) =>
                [...prev, { index, label: accountLabel(nextMeta, index), address: manager.address }].sort(
                    (a, b) => a.index - b.index,
                ),
            );
            setAccount({
                address: manager.address,
                // A restored account may well be deployed already — check live.
                isDeployed: restoring !== null ? await isInitialized(w, manager.address) : false,
                index,
                label: accountLabel(nextMeta, index),
            });
        },
        [persistAccountsMeta],
    );

    const removeAccount = useCallback(
        async (index: number) => {
            const meta = accountsMetaRef.current;
            const visible = visibleIndices(meta);
            if (!visible.includes(index)) throw new Error(`No account at index ${index}.`);
            if (visible.length <= 1) throw new Error("You can't remove your only account.");
            if (index === activeIndexRef.current) {
                throw new Error("Switch to another account first, then remove this one.");
            }
            // Hide, never delete: the derivation (and any funds) is recoverable
            // via "+ New account", which restores hidden indices first.
            await persistAccountsMeta({ ...meta, hidden: [...(meta.hidden ?? []), index] });
            managersRef.current.delete(index);
            setAccounts((prev) => prev.filter((a) => a.index !== index));
        },
        [persistAccountsMeta],
    );

    const renameAccount = useCallback(
        async (index: number, label: string) => {
            const trimmed = label.trim();
            if (!trimmed) throw new Error("Label is required.");
            if (trimmed.length > 24) throw new Error("Label must be 24 characters or fewer.");
            const meta = accountsMetaRef.current;
            if (index < 0 || index >= meta.count) throw new Error(`No account at index ${index}.`);
            await persistAccountsMeta({
                ...meta,
                labels: { ...meta.labels, [index]: trimmed },
            });
            setAccounts((prev) =>
                prev.map((a) => (a.index === index ? { ...a, label: trimmed } : a)),
            );
            setAccount((prev) => (prev && prev.index === index ? { ...prev, label: trimmed } : prev));
        },
        [persistAccountsMeta],
    );

    const unlockWithPasskey = useCallback(async () => {
        setStatus("unlocking");
        try {
            const secret = await vaultStore.unlockWithPasskey();
            await handleUnlocked(network, secret);
        } catch (err) {
            setStatus("locked");
            throw err;
        }
    }, [network, handleUnlocked]);

    const unlockWithPassphrase = useCallback(
        async (passphrase: string) => {
            setStatus("unlocking");
            try {
                const secret = await vaultStore.unlockWithPassphrase(passphrase);
                await handleUnlocked(network, secret);
            } catch (err) {
                setStatus("locked");
                throw err;
            }
        },
        [network, handleUnlocked],
    );

    const createAccountWithPasskey = useCallback(
        async (mnemonic: string, label: string) => {
            await vaultStore.createWithPasskey(mnemonic, label);
            const secret = vaultStore.getUnlocked();
            if (!secret) throw new Error("Vault did not unlock after creation.");
            await handleUnlocked(network, secret);
        },
        [network, handleUnlocked],
    );

    const createAccountWithPassphrase = useCallback(
        async (mnemonic: string, passphrase: string) => {
            await vaultStore.createWithPassphrase(mnemonic, passphrase);
            const secret = vaultStore.getUnlocked();
            if (!secret) throw new Error("Vault did not unlock after creation.");
            await handleUnlocked(network, secret);
        },
        [network, handleUnlocked],
    );

    const setNetwork = useCallback(
        async (id: AztecNetwork["id"]) => {
            const n = await resolveNetwork(id);
            await storage.set(KEYS.network, id);
            setNetworkState(n);
            setBootError(null);
            const secret = vaultStore.getUnlocked();
            if (secret) {
                setWallet(null);
                setAccount(null);
                await handleUnlocked(n, secret);
            }
        },
        [handleUnlocked],
    );

    const lock = useCallback(() => {
        vaultStore.lock();
        setMetaKeyProvider(null);
        void stopCurrentWallet();
        setWallet(null);
        setAccount(null);
        setBootError(null);
        setStatus("locked");
    }, [stopCurrentWallet]);

    // Idle auto-lock: while a decrypted secret is resident (ready, or stuck on
    // the boot/boot-error screen which also holds it), re-lock after 5 minutes
    // without user interaction. Detached/pinned popups otherwise keep the
    // unlocked seed in memory indefinitely.
    //
    // While a user-initiated transaction is in flight (first deploy = CRS
    // download + proving + inclusion, easily >5 min of just watching), locking
    // would tear down the PXE mid-proof — so the deadline DEFERS until the
    // operation settles, then a fresh idle window starts.
    useEffect(() => {
        if (status !== "ready" && status !== "loading") return;
        let timer: number | undefined;
        let lastInteractionAt = Date.now();
        const tick = () => {
            // Defer for an in-flight op — UNLESS we've already deferred past the
            // absolute ceiling since the last user interaction. A stalled/hostile
            // node can keep hasActiveOps() true forever; the ceiling guarantees
            // the seed is still wiped (vaultStore.lock zeroes it + clears the
            // session cache) so the idle-lock control can't be bypassed.
            const idleFor = Date.now() - lastInteractionAt;
            if (hasActiveOps() && idleFor < MAX_IDLE_DEFERRAL_MS) {
                timer = window.setTimeout(tick, IDLE_LOCK_MS);
                return;
            }
            lock();
        };
        const arm = () => {
            lastInteractionAt = Date.now();
            window.clearTimeout(timer);
            timer = window.setTimeout(tick, IDLE_LOCK_MS);
        };
        const events = ["mousedown", "keydown", "pointermove", "wheel", "touchstart"] as const;
        for (const e of events) window.addEventListener(e, arm, { passive: true });
        arm();
        return () => {
            window.clearTimeout(timer);
            for (const e of events) window.removeEventListener(e, arm);
        };
    }, [status, lock]);

    const destroy = useCallback(async () => {
        await vaultStore.destroy();
        setMetaKeyProvider(null);
        await stopCurrentWallet();
        setWallet(null);
        setAccount(null);
        setBootError(null);
        setStatus("uninitialized");
    }, [stopCurrentWallet]);

    const value = useMemo<Ctx>(
        () => ({
            status,
            network,
            networks: SELECTABLE_NETWORKS,
            setNetwork,
            account,
            accounts,
            switchAccount,
            addAccount,
            renameAccount,
            removeAccount,
            wallet,
            bootError,
            retryBoot,
            ensureAccountDeployed,
            onboardingMethod: vaultStore.method(),
            unlockWithPasskey,
            unlockWithPassphrase,
            createAccountWithPasskey,
            createAccountWithPassphrase,
            lock,
            destroy,
        }),
        [
            status,
            network,
            account,
            accounts,
            switchAccount,
            addAccount,
            renameAccount,
            removeAccount,
            wallet,
            bootError,
            retryBoot,
            ensureAccountDeployed,
            setNetwork,
            unlockWithPasskey,
            unlockWithPassphrase,
            createAccountWithPasskey,
            createAccountWithPassphrase,
            lock,
            destroy,
        ],
    );

    return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useWallet(): Ctx {
    const ctx = useContext(WalletCtx);
    if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>.");
    return ctx;
}
