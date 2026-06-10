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
    NETWORKS,
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
import { markFeeConsumed, resolveFeePaymentMethod } from "../aztec/fee";
import { syncContactsToPxe, syncKnownSendersToPxe } from "../aztec/contacts";
import { secureGet, secureSet, setMetaKeyProvider } from "../secureStorage";
import { hasActiveOps, trackOp } from "./activity";
import { drainClaimInbox } from "../aztec/claimInbox";

type AccountManager = Awaited<ReturnType<AztecWallet["createSchnorrAccount"]>>;

type Status = "uninitialized" | "locked" | "unlocking" | "loading" | "ready";

/** Re-lock the wallet after this much user inactivity while unlocked. */
const IDLE_LOCK_MS = 5 * 60_000;

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
};

const DEFAULT_ACCOUNTS_META: AccountsMeta = { count: 1, activeIndex: 0, labels: {} };
const MAX_ACCOUNTS = 16;

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

async function initialStatus(): Promise<Status> {
    return vaultStore.isInitialized() ? "locked" : "uninitialized";
}

async function loadNetwork(): Promise<AztecNetwork> {
    const id = (await storage.get<AztecNetwork["id"]>(KEYS.network)) ?? DEFAULT_NETWORK_ID;
    try {
        return await resolveNetwork(id);
    } catch {
        // A stored "custom" selection whose URL was wiped — fall back to default
        // explicitly rather than booting nothing.
        return getNetwork(DEFAULT_NETWORK_ID);
    }
}

async function loadAccountsMeta(): Promise<AccountsMeta> {
    const stored = await secureGet<AccountsMeta>(KEYS.accountsMeta);
    if (!stored || !Number.isInteger(stored.count) || stored.count < 1) {
        return DEFAULT_ACCOUNTS_META;
    }
    return {
        count: Math.min(stored.count, MAX_ACCOUNTS),
        activeIndex: Math.min(Math.max(stored.activeIndex ?? 0, 0), stored.count - 1),
        labels: stored.labels ?? {},
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

    // Register EVERY known account in the PXE so notes for all of them are
    // discovered continuously; only the active one drives the UI.
    const managers = new Map<number, AccountManager>();
    const accounts: AccountListEntry[] = [];
    for (let i = 0; i < meta.count; i++) {
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

    useEffect(() => {
        Promise.all([initialStatus(), loadNetwork()]).then(([s, n]) => {
            setStatus(s);
            setNetworkState(n);
        });
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
            // Register the known-sender set (named contacts + everyone you've
            // sent to) into the PXE so incoming private notes from them are
            // discovered on the fast tagged path. Fire-and-forget so the UI
            // doesn't block on PXE writes.
            syncContactsToPxe(net.id, w).catch((err) =>
                console.warn("Contact sync failed:", err),
            );
            syncKnownSendersToPxe(net.id, w).catch((err) =>
                console.warn("Known-sender sync failed:", err),
            );
        } catch (err) {
            setBootError(err instanceof Error ? err.message : String(err));
            // Stay in "loading" so the LoadingScreen renders the error/retry UI.
        }
    }, [stopCurrentWallet]);

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
            setAccount((prev) => (prev ? { ...prev, isDeployed: true } : prev));
            return;
        }

        if (!deployInFlightRef.current) {
            deployInFlightRef.current = trackOp(async () => {
                const net = networkRef.current;
                const fee = await resolveFeePaymentMethod(w, net, manager.address);
                if (!fee.method) {
                    throw new Error(
                        net.hasSponsoredFPC
                            ? "Couldn't resolve a fee payment method to activate the account."
                            : "Your account needs fee juice before its first transaction. " +
                              "Bridge ETH (sandbox) or use the network faucet, then try again.",
                    );
                }
                await deployAccountContract({ wallet: w, manager, feeMethod: fee.method });
                await markFeeConsumed(fee);
                setAccount((prev) => (prev ? { ...prev, isDeployed: true } : prev));
            }).finally(() => {
                deployInFlightRef.current = null;
            });
        }
        await deployInFlightRef.current;
    }, []);

    const persistAccountsMeta = useCallback(async (meta: AccountsMeta) => {
        accountsMetaRef.current = meta;
        await secureSet(KEYS.accountsMeta, meta);
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
            if (meta.count >= MAX_ACCOUNTS) {
                throw new Error(`Account limit reached (${MAX_ACCOUNTS}).`);
            }
            const index = meta.count;
            const cleanLabel = label?.trim();
            const nextMeta: AccountsMeta = {
                count: meta.count + 1,
                activeIndex: index,
                labels: cleanLabel ? { ...meta.labels, [index]: cleanLabel } : meta.labels,
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
            setAccounts((prev) => [
                ...prev,
                { index, label: accountLabel(nextMeta, index), address: manager.address },
            ]);
            setAccount({
                address: manager.address,
                isDeployed: false, // brand-new derivation can't be deployed yet
                index,
                label: accountLabel(nextMeta, index),
            });
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
        const arm = () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                if (hasActiveOps()) {
                    arm();
                    return;
                }
                lock();
            }, IDLE_LOCK_MS);
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
            networks: NETWORKS,
            setNetwork,
            account,
            accounts,
            switchAccount,
            addAccount,
            renameAccount,
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
