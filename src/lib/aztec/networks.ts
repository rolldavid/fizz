export type AztecNetwork = {
    id: "sandbox" | "testnet" | "devnet" | "alpha" | "custom";
    name: string;
    description: string;
    nodeUrl: string;
    l1ChainId: number;
    /** Informational. PXE reads the canonical value from the node directly. */
    rollupVersion: number;
    hasSponsoredFPC: boolean;
    /** Optional URL to a hosted faucet that funds new accounts with fee juice. */
    faucetUrl?: string;
};

/**
 * Network registry.
 *
 * Current focus (per project owner): the **local sandbox** is the default while
 * we harden the wallet. Public testnet and the alpha/mainnet endpoint are wired
 * up but the owner is configuring those separately and will supply the canonical
 * alpha endpoint — see the `alpha` slot at the bottom.
 *
 * `rollupVersion` is informational here; PXE reads the canonical value from the
 * node itself at boot, so a stale number here never causes a wrong-chain tx.
 */
export const NETWORKS: AztecNetwork[] = [
    {
        id: "sandbox",
        name: "Local sandbox",
        description: "aztec start --local-network",
        nodeUrl: "http://localhost:8080",
        l1ChainId: 31337,
        // Informational only; the live sandbox reports a non-zero rollupVersion
        // that changes per boot. PXE reads the real value from the node.
        rollupVersion: 0,
        // Confirmed from the running node config (`"sponsoredFPC":false`):
        // `aztec start --local-network` does NOT deploy a SponsoredFPC, and there
        // is no start flag to enable one. A freshly-derived account therefore has
        // no fee payer until it bridges fee juice from L1 (Home → "Bridge ETH"),
        // after which the first tx deploys the account + pays via the claim.
        hasSponsoredFPC: false,
    },
    {
        id: "testnet",
        name: "Aztec Testnet (alpha)",
        description: "Public alpha-testnet · hosted by Nethermind",
        nodeUrl: "https://rpc.testnet.aztec-labs.com",
        l1ChainId: 11155111, // Sepolia
        rollupVersion: 4127419662,
        // VERIFIED 2026-06-09 against the live testnet node:
        //   - The address this wallet computes from the bundled artifact +
        //     SPONSORED_FPC_SALT (0x08b8…765b) IS deployed on testnet, with
        //     contract class 0x216c0b…7eb7 — exactly the bundled artifact's
        //     class id — and holds a positive fee-juice balance.
        //   - The docs-published 0x2540…1257 is a DIFFERENT class (an older
        //     SDK era's artifact). Our derivation must keep using the bundled
        //     artifact: instance and artifact must match for the PXE to prove.
        hasSponsoredFPC: true,
        faucetUrl: "https://aztec-faucet.nethermind.io/",
    },
    {
        id: "devnet",
        name: "Aztec Devnet",
        description: "Older public dev network — frequently offline",
        nodeUrl: "https://v4-devnet-2.aztec-labs.com/",
        l1ChainId: 11155111,
        rollupVersion: 615022430,
        hasSponsoredFPC: true,
    },
    // ── Alpha / mainnet ──────────────────────────────────────────────────────
    // No live Aztec mainnet exists yet (the public network is in its "alpha"
    // phase = the testnet above). The owner will supply the canonical alpha
    // endpoint; fill these in and flip DEFAULT_NETWORK_ID to "alpha" then.
    // {
    //     id: "alpha",
    //     name: "Aztec Alpha",
    //     description: "Aztec alpha network",
    //     nodeUrl: "<provided by owner>",
    //     l1ChainId: 1,            // confirm against the supplied endpoint
    //     rollupVersion: 0,        // informational; PXE reads canonical from node
    //     hasSponsoredFPC: false,  // confirm the canonical FPC address first
    // },
];

// TESTNET-FIRST for live alpha testing: every flow (account deploy, token
// deploy, mint private/public, private+public transfers, shield/unshield,
// bridge claim) is verified green on this network with real proofs. The local
// sandbox remains one click away in the network picker for development.
export const DEFAULT_NETWORK_ID: AztecNetwork["id"] = "testnet";

export function getNetwork(id: AztecNetwork["id"]): AztecNetwork {
    const n = NETWORKS.find((x) => x.id === id);
    if (!n) throw new Error(`Unknown network: ${id}`);
    return n;
}

// ── Custom node ──────────────────────────────────────────────────────────────
// Privacy escape hatch: the configured node sees your address + IP + query
// pattern, so users must be able to point the wallet at a node THEY trust
// (their own, or a community one). Persisted locally; never synced.

import { KEYS, storage } from "../storage";

export function validateCustomNodeUrl(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new Error("Enter a full node URL, e.g. https://my-node.example or http://localhost:8080");
    }
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol === "http:" && !isLocal) {
        throw new Error("Remote nodes must use https — http is only allowed for localhost.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Node URL must be http(s).");
    }
    return url.toString().replace(/\/$/, "");
}

export async function saveCustomNodeUrl(rawUrl: string): Promise<string> {
    const url = validateCustomNodeUrl(rawUrl);
    await storage.set(KEYS.customNode, url);
    return url;
}

export async function loadCustomNodeUrl(): Promise<string | undefined> {
    return storage.get<string>(KEYS.customNode);
}

/**
 * Resolve a network id to its full config, including the storage-backed
 * custom entry. Throws if "custom" is selected but no URL has been saved.
 */
export async function resolveNetwork(id: AztecNetwork["id"]): Promise<AztecNetwork> {
    if (id !== "custom") return getNetwork(id);
    const nodeUrl = await loadCustomNodeUrl();
    if (!nodeUrl) throw new Error("No custom node configured.");
    return {
        id: "custom",
        name: "Custom node",
        description: nodeUrl,
        nodeUrl,
        // Informational only — the PXE reads chain ids from the node itself.
        l1ChainId: 0,
        rollupVersion: 0,
        // Unknown in advance; fee.ts probes the chain for the sponsored FPC.
        hasSponsoredFPC: false,
    };
}
