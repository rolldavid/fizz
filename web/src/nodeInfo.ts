/**
 * Live network discovery — the canonical L1 contract addresses (FeeJuicePortal,
 * the L1 fee ERC20, the testnet-only free minter) are fetched from the Aztec
 * node on every load, never hardcoded.
 */

export type Hex = `0x${string}`;

export type AztecNodeInfo = {
    nodeVersion: string;
    l1ChainId: number;
    /** Canonical FeeJuicePortal on L1. */
    feeJuicePortalAddress: Hex;
    /** The L1 fee ERC20 (symbol may be "AZTEC" or "FEE" — we read it live). */
    feeJuiceAddress: Hex;
    /** Testnet-only free minter; null on networks without a faucet handler. */
    feeAssetHandlerAddress: Hex | null;
};

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function requireAddress(value: unknown, field: string): Hex {
    if (typeof value !== "string" || !HEX_ADDRESS.test(value)) {
        throw new Error(`Aztec node response is missing l1ContractAddresses.${field}.`);
    }
    return value as Hex;
}

/**
 * Fetch + verify the node's L1 contracts.
 *
 * When `pin` is given (mainnet — real funds) the value-moving contracts MUST
 * match it or we refuse: a hostile/compromised node could otherwise make the
 * user approve and deposit straight into a thief's portal/asset. When `pin` is
 * null (testnet) we trust the node's node-info — it's free practice and testnet
 * redeploys.
 */
export async function fetchNodeInfo(
    nodeUrl: string,
    pin: { feeJuicePortalAddress: string; feeJuiceAddress: string } | null,
): Promise<AztecNodeInfo> {
    const res = await fetch(nodeUrl, {
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

    if (pin) {
        const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
        if (
            !eq(feeJuicePortalAddress, pin.feeJuicePortalAddress) ||
            !eq(feeJuiceAddress, pin.feeJuiceAddress)
        ) {
            throw new Error(
                "Safety check failed: the Aztec node reported L1 fee-juice contracts that do not match " +
                    "Fizz's pinned addresses. Refusing to continue (your node may be compromised, or Aztec " +
                    `redeployed and this page needs updating). Node portal=${feeJuicePortalAddress} asset=${feeJuiceAddress}.`,
            );
        }
    }

    return {
        nodeVersion: typeof result.nodeVersion === "string" ? result.nodeVersion : "unknown-version",
        l1ChainId: result.l1ChainId,
        feeJuicePortalAddress,
        feeJuiceAddress,
        feeAssetHandlerAddress:
            handler === undefined || handler === null
                ? null
                : requireAddress(handler, "feeAssetHandlerAddress"),
    };
}
