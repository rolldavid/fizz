/**
 * Site-wide Ethereum connection, address-blind in the UI layer.
 *
 * Mounted once at the app root so the nav's ETH chip and the bridge page share
 * one connection that persists across client-side routes. The heavy wagmi/viem
 * code lives in ./wagmi and is pulled in with a dynamic import() — but THIS
 * provider's element tree is stable (the context value swaps, no extra provider
 * is inserted), so loading wagmi never remounts the app.
 *
 * No auto-reconnect: the address only enters the page after an explicit connect.
 */
import {
    createContext,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import type { Address } from "viem";
import type { Config } from "wagmi";
import type { EthSnapshot, EthWallet } from "./wagmi";

type WagmiModule = typeof import("./wagmi");

export type EthStatus = "loading" | "disconnected" | "connecting" | "connected";

type EthValue = {
    /** wagmi chunk loaded — until then status is "loading". */
    ready: boolean;
    status: EthStatus;
    /** Connected wallet's display name (e.g. "MetaMask"); never shown as an address. */
    walletName: string | null;
    /** The connected L1 address — for the bridge flow only; the nav never renders it. */
    address: Address | null;
    /** Installed MetaMask/Rabby connectors to choose from. */
    wallets: EthWallet[];
    connect: (id: string) => Promise<void>;
    disconnect: () => Promise<void>;
    /** wagmi Config for wagmi/actions on the bridge page; null until loaded. */
    config: Config | null;
};

const EthContext = createContext<EthValue | null>(null);

export function useEth(): EthValue {
    const v = useContext(EthContext);
    if (!v) throw new Error("useEth must be used within <EthProvider>");
    return v;
}

const EMPTY_SNAPSHOT: EthSnapshot = { status: "disconnected", wallets: [] };

export function EthProvider({ children }: { children: ReactNode }) {
    const modRef = useRef<WagmiModule | null>(null);
    const unsubRef = useRef<(() => void) | null>(null);
    const [ready, setReady] = useState(false);
    const [snap, setSnap] = useState<EthSnapshot>(EMPTY_SNAPSHOT);

    // Wire a freshly-loaded module into local state + a live subscription, once.
    function adopt(mod: WagmiModule) {
        if (modRef.current) return;
        modRef.current = mod;
        setSnap(mod.getSnapshot());
        unsubRef.current = mod.subscribe(() => setSnap(mod.getSnapshot()));
        setReady(true);
    }

    // Preload the wagmi chunk shortly after mount so it's ready by the time the
    // user reaches /bridge — but off the home page's initial bundle.
    useEffect(() => {
        let cancelled = false;
        import("./wagmi")
            .then((mod) => {
                if (!cancelled) adopt(mod);
            })
            .catch(() => {
                /* Stays not-ready; an explicit connect() retries the import. */
            });
        return () => {
            cancelled = true;
            unsubRef.current?.();
            unsubRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function ensureMod(): Promise<WagmiModule> {
        if (modRef.current) return modRef.current;
        const mod = await import("./wagmi");
        adopt(mod);
        return mod;
    }

    const value: EthValue = {
        ready,
        status: !ready
            ? "loading"
            : snap.status === "connected"
              ? "connected"
              : snap.status === "connecting" || snap.status === "reconnecting"
                ? "connecting"
                : "disconnected",
        walletName: snap.walletName ?? null,
        address: snap.address ?? null,
        wallets: snap.wallets,
        connect: async (id) => {
            const mod = await ensureMod();
            await mod.connectWallet(id);
        },
        disconnect: async () => {
            const mod = await ensureMod();
            await mod.disconnectWallet();
        },
        config: modRef.current?.config ?? null,
    };

    return <EthContext.Provider value={value}>{children}</EthContext.Provider>;
}
