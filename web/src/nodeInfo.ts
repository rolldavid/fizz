/**
 * Live network discovery — the canonical L1 contract addresses (FeeJuicePortal,
 * the L1 fee ERC20, the testnet-only free minter) are NEVER hardcoded; they are
 * fetched from the Aztec testnet node on every page load.
 */

import { AZTEC_NODE_URL } from "./config";

export type Hex = `0x${string}`;

/**
 * PINNED canonical L1 contracts for Aztec ALPHA (mainnet). The node reports
 * these, but the page then signs an ERC-20 `approve(portal, …)` and a
 * `portal.depositToAztecPublic(…)` against them — so a hostile/compromised node
 * that returned an attacker `portal`/`asset` could make the user approve and
 * deposit straight into a thief. We fetch live (so a legit redeploy is caught
 * loudly) but REFUSE to proceed unless the value-moving contracts match this
 * pin. Update this set if/when Aztec redeploys the mainnet portal/asset.
 *
 * The fee asset is the AZTEC token; both addresses are from the canonical Aztec
 * docs and verified against the live mainnet node.
 */
const PINNED_MAINNET = {
    feeJuicePortalAddress: "0x2891f8b941067f8b5a3f34545a30cf71e3e23617",
    feeJuiceAddress: "0xa27ec0006e59f245217ff08cd52a7e8b169e62d2",
} as const;

export type AztecNodeInfo = {
    nodeVersion: string;
    l1ChainId: number;
    /** Canonical FeeJuicePortal on L1. */
    feeJuicePortalAddress: Hex;
    /** The L1 fee ERC20 (symbol may be "AZTEC" or "FEE" — we read it live). */
    feeJuiceAddress: Hex;
    /** Testnet-only free minter; absent on networks without a faucet handler. */
    feeAssetHandlerAddress: Hex | null;
};

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function requireAddress(value: unknown, field: string): Hex {
    if (typeof value !== "string" || !HEX_ADDRESS.test(value)) {
        throw new Error(`Aztec node response is missing l1ContractAddresses.${field}.`);
    }
    return value as Hex;
}

export async function fetchNodeInfo(): Promise<AztecNodeInfo> {
    const res = await fetch(AZTEC_NODE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node_getNodeInfo", params: [] }),
    });
    if (!res.ok) {
        throw new Error(`Aztec node returned HTTP ${res.status} for node_getNodeInfo.`);
    }
    const body = (await res.json()) as {
        result?: {
            nodeVersion?: unknown;
            l1ChainId?: unknown;
            l1ContractAddresses?: Record<string, unknown>;
        };
        error?: { message?: string };
    };
    if (body.error) {
        throw new Error(`Aztec node error: ${body.error.message ?? "unknown error"}`);
    }
    const result = body.result;
    if (!result || typeof result !== "object") {
        throw new Error("Aztec node returned no result for node_getNodeInfo.");
    }
    if (typeof result.l1ChainId !== "number") {
        throw new Error("Aztec node response is missing l1ChainId.");
    }
    const l1 = result.l1ContractAddresses;
    if (!l1 || typeof l1 !== "object") {
        throw new Error("Aztec node response is missing l1ContractAddresses.");
    }
    const handler = l1.feeAssetHandlerAddress;
    const feeJuicePortalAddress = requireAddress(l1.feeJuicePortalAddress, "feeJuicePortalAddress");
    const feeJuiceAddress = requireAddress(l1.feeJuiceAddress, "feeJuiceAddress");

    // Hard-fail if the node's value-moving contracts diverge from the pin — the
    // user must never approve/deposit against an unverified portal/asset.
    const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (
        !eq(feeJuicePortalAddress, PINNED_MAINNET.feeJuicePortalAddress) ||
        !eq(feeJuiceAddress, PINNED_MAINNET.feeJuiceAddress)
    ) {
        throw new Error(
            "Safety check failed: the Aztec node reported L1 fee-juice contracts that do not match " +
                "Fizz's pinned mainnet addresses. Refusing to continue (your node may be compromised, " +
                "or Aztec redeployed and this page needs updating). " +
                `Node portal=${feeJuicePortalAddress} asset=${feeJuiceAddress}.`,
        );
    }

    return {
        nodeVersion: typeof result.nodeVersion === "string" ? result.nodeVersion : "unknown-version",
        l1ChainId: result.l1ChainId,
        feeJuicePortalAddress,
        feeJuiceAddress,
        // Genuinely optional: some networks simply have no free minter. null is
        // an explicit "not available" state the UI must handle, not a fallback.
        feeAssetHandlerAddress:
            handler === undefined || handler === null
                ? null
                : requireAddress(handler, "feeAssetHandlerAddress"),
    };
}
