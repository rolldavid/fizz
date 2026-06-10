/**
 * The Ethereum side of the bridge, wagmi-only — NO RainbowKit, NO WalletConnect.
 *
 * This whole module is loaded via a dynamic import() from EthProvider, so wagmi
 * + viem land in their own chunk and never weigh down the home page's initial
 * payload. Connection is discovered through EIP-6963 (multiInjectedProvider-
 * Discovery) and the UI is filtered to MetaMask + Rabby only — both are injected
 * wallets, so we need no relay and the CSP can drop WalletConnect entirely.
 *
 * We deliberately do NOT auto-reconnect: the user's address never enters the
 * page's JS context until they explicitly connect (EthProvider never calls
 * `reconnect`). Within an SPA session the connection persists across routes
 * because the config is a singleton; a hard reload starts disconnected.
 */
import { createConfig, http } from "wagmi";
import { mainnet, sepolia } from "wagmi/chains";
import {
    connect,
    disconnect,
    getAccount,
    getConnectors,
    watchAccount,
    watchConnectors,
} from "wagmi/actions";
import type { Address } from "viem";
import { BRIDGE_NETWORKS } from "../networks";

// Both L1 chains the bridge can target: Ethereum mainnet (real) and Sepolia
// (testnet practice). The /bridge toggle switches the connected wallet between
// them; the config carries a transport for each.
export const config = createConfig({
    chains: [mainnet, sepolia],
    transports: {
        [mainnet.id]: http(BRIDGE_NETWORKS.mainnet.l1RpcUrl),
        [sepolia.id]: http(BRIDGE_NETWORKS.testnet.l1RpcUrl),
    },
    // EIP-6963 discovery is on by default; we surface only MetaMask + Rabby.
    multiInjectedProviderDiscovery: true,
});

/** rdns (EIP-6963) → display name for the only wallets we offer. */
const ALLOWED: Record<string, string> = {
    "io.metamask": "MetaMask",
    "io.rabby": "Rabby",
};

export type EthWallet = { id: string; name: string; icon?: string };

/** Discovered injected connectors, filtered to MetaMask + Rabby, de-duped by id. */
function allowedWallets(): EthWallet[] {
    const seen = new Set<string>();
    const out: EthWallet[] = [];
    for (const c of getConnectors(config)) {
        const allowed = c.id in ALLOWED || /meta\s*mask|rabby/i.test(c.name);
        if (!allowed || seen.has(c.id)) continue;
        seen.add(c.id);
        out.push({ id: c.id, name: ALLOWED[c.id] ?? c.name, icon: c.icon });
    }
    return out;
}

export type EthAccountStatus = "connected" | "connecting" | "reconnecting" | "disconnected";
export type EthSnapshot = {
    status: EthAccountStatus;
    address?: Address;
    walletName?: string;
    wallets: EthWallet[];
};

export function getSnapshot(): EthSnapshot {
    const a = getAccount(config);
    return {
        status: a.status,
        address: a.address,
        walletName: a.connector?.name,
        wallets: allowedWallets(),
    };
}

/** Subscribe to account + connector changes; returns an unsubscribe fn. */
export function subscribe(onChange: () => void): () => void {
    const offAccount = watchAccount(config, { onChange });
    const offConnectors = watchConnectors(config, { onChange });
    return () => {
        offAccount();
        offConnectors();
    };
}

export async function connectWallet(id: string): Promise<void> {
    const connector = getConnectors(config).find((c) => c.id === id);
    if (!connector) {
        throw new Error("That wallet isn't available. Make sure MetaMask or Rabby is installed and enabled.");
    }
    await connect(config, { connector });
}

export async function disconnectWallet(): Promise<void> {
    await disconnect(config);
}
