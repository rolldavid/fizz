/**
 * Live network discovery — the canonical L1 contract addresses (FeeJuicePortal,
 * the L1 fee ERC20, the testnet-only free minter) are NEVER hardcoded; they are
 * fetched from the Aztec testnet node on every page load.
 */

import { AZTEC_NODE_URL } from "./config";

export type Hex = `0x${string}`;

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
    return {
        nodeVersion: typeof result.nodeVersion === "string" ? result.nodeVersion : "unknown-version",
        l1ChainId: result.l1ChainId,
        feeJuicePortalAddress: requireAddress(l1.feeJuicePortalAddress, "feeJuicePortalAddress"),
        feeJuiceAddress: requireAddress(l1.feeJuiceAddress, "feeJuiceAddress"),
        // Genuinely optional: some networks simply have no free minter. null is
        // an explicit "not available" state the UI must handle, not a fallback.
        feeAssetHandlerAddress:
            handler === undefined || handler === null
                ? null
                : requireAddress(handler, "feeAssetHandlerAddress"),
    };
}
