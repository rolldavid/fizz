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
    /** Public L1 JSON-RPC used by the in-wallet funding account for bridging. */
    l1RpcUrl?: string;
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
        l1RpcUrl: "http://localhost:8545",
    },
    {
        id: "alpha",
        name: "Aztec Mainnet",
        description: "Production · Ethereum L1",
        nodeUrl: "https://lb.drpc.live/aztec-mainnet/AsSP5jeGMUnUmdsy88mWgdsyXG-SZcwR8ZfEVjewFaCJ",
        l1ChainId: 1, // Ethereum mainnet
        rollupVersion: 2934756905,
        // Mainnet has NO SponsoredFPC deployed and NO faucet (docs + live node:
        // feeAssetHandlerAddress is empty). The fee asset IS the AZTEC token
        // (0xa27ec0…, also the staking asset). So a fresh account cannot transact
        // until it bridges AZTEC → fee juice on fizzwallet.com/bridge. fee.ts
        // still probes on-chain, so this flag is just the (false) hint.
        hasSponsoredFPC: false,
        // Without this, recoverInFlightBridges never runs on mainnet and every
        // bridge deposit strands at "sent" (the secret survives locally, but
        // the claim can't complete). Must stay in the manifest's connect-src.
        l1RpcUrl: "https://lb.drpc.live/ethereum/AsSP5jeGMUnUmdsy88mWgdsyXG-SZcwR8ZfEVjewFaCJ",
    },
    {
        id: "testnet",
        name: "Aztec Testnet",
        description: "Public testnet · Sepolia L1",
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
        l1RpcUrl: "https://lb.drpc.live/sepolia/AsSP5jeGMUnUmdsy88mWgdsyXG-SZcwR8ZfEVjewFaCJ",
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
];

// Alpha (Mainnet) is the default — production, real value. NOTE: mainnet has no
// SponsoredFPC and no faucet, so a brand-new wallet here holds no fee juice and
// CANNOT transact (not even deploy its account) until the user bridges AZTEC →
// fee juice on fizzwallet.com/bridge. The UI must lead with that. Testnet (free
// via its SponsoredFPC) stays one tap away in the network picker for trying
// things out without real funds.
export const DEFAULT_NETWORK_ID: AztecNetwork["id"] = "alpha";

export function getNetwork(id: AztecNetwork["id"]): AztecNetwork {
    const n = NETWORKS.find((x) => x.id === id);
    if (!n) throw new Error(`Unknown network: ${id}`);
    return n;
}

/**
 * Networks offered in the wallet's picker, in order — Mainnet first (the
 * default). The local `sandbox` and `devnet` stay in NETWORKS (tests/e2e and
 * the registry use them) but are hidden here, and custom-node selection was
 * removed: only Mainnet and Testnet show.
 */
export const SELECTABLE_NETWORK_IDS: AztecNetwork["id"][] = ["alpha", "testnet"];
export const SELECTABLE_NETWORKS: AztecNetwork[] = SELECTABLE_NETWORK_IDS.map(getNetwork);

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
        throw new Error("Enter a full node URL, e.g. https://my-node.aztec-labs.com or http://localhost:8080");
    }
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol === "http:" && !isLocal) {
        throw new Error("Remote nodes must use https — http is only allowed for localhost.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Node URL must be http(s).");
    }
    // HONESTY over a silent failure: the extension's CSP `connect-src` (locked
    // down so a compromised dependency can't exfiltrate the seed) only permits
    // localhost and *.aztec-labs.com origins. A custom node on any other remote
    // host would be blocked by the browser at fetch time with an opaque error.
    // Reject it up front with an explanation instead. (Running your own node
    // today means localhost — e.g. via an SSH tunnel — or a self-built
    // extension with your origin added to connect-src.)
    const isAztecLabs = url.hostname === "aztec-labs.com" || url.hostname.endsWith(".aztec-labs.com");
    if (!isLocal && !isAztecLabs) {
        throw new Error(
            "For your seed's safety the wallet only permits network egress to localhost and " +
                "*.aztec-labs.com. A node on " +
                url.hostname +
                " would be blocked by the extension's content-security policy. Use a localhost " +
                "node (e.g. an SSH tunnel to your own), or build the extension with your node's " +
                "origin added to connect-src.",
        );
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
