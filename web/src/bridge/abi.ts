/**
 * Minimal hand-written ABIs for the three L1 contracts the bridge touches.
 * Copied 1:1 from @aztec/l1-artifacts@4.3.0 (FeeJuicePortalAbi /
 * FeeAssetHandlerAbi / TestERC20Abi) — only the fragments this page calls, so
 * the L1 artifacts package never enters the bundle. The contract ADDRESSES are
 * never hardcoded; they come live from the Aztec node (see ../nodeInfo.ts).
 */

/** Testnet-only faucet: mints a FIXED batch (mintAmount) per call, free. */
export const feeAssetHandlerAbi = [
    {
        type: "function",
        name: "mintAmount",
        inputs: [],
        outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "mint",
        inputs: [{ name: "_recipient", type: "address", internalType: "address" }],
        outputs: [],
        stateMutability: "nonpayable",
    },
] as const;

/** The L1 fee ERC20 (TestERC20 on testnet; symbol read live — "AZTEC"/"FEE"). */
export const feeAssetAbi = [
    {
        type: "function",
        name: "symbol",
        inputs: [],
        outputs: [{ name: "", type: "string", internalType: "string" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "decimals",
        inputs: [],
        outputs: [{ name: "", type: "uint8", internalType: "uint8" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "balanceOf",
        inputs: [{ name: "account", type: "address", internalType: "address" }],
        outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "approve",
        inputs: [
            { name: "spender", type: "address", internalType: "address" },
            { name: "value", type: "uint256", internalType: "uint256" },
        ],
        outputs: [{ name: "", type: "bool", internalType: "bool" }],
        stateMutability: "nonpayable",
    },
] as const;

/** Canonical FeeJuicePortal — the ONLY way fee juice enters Aztec (L1→L2). */
export const feeJuicePortalAbi = [
    {
        type: "function",
        name: "depositToAztecPublic",
        inputs: [
            { name: "_to", type: "bytes32", internalType: "bytes32" },
            { name: "_amount", type: "uint256", internalType: "uint256" },
            { name: "_secretHash", type: "bytes32", internalType: "bytes32" },
        ],
        outputs: [
            { name: "", type: "bytes32", internalType: "bytes32" },
            { name: "", type: "uint256", internalType: "uint256" },
        ],
        stateMutability: "nonpayable",
    },
    {
        type: "event",
        name: "DepositToAztecPublic",
        inputs: [
            { name: "to", type: "bytes32", indexed: true, internalType: "bytes32" },
            { name: "amount", type: "uint256", indexed: false, internalType: "uint256" },
            { name: "secretHash", type: "bytes32", indexed: false, internalType: "bytes32" },
            { name: "key", type: "bytes32", indexed: false, internalType: "bytes32" },
            { name: "index", type: "uint256", indexed: false, internalType: "uint256" },
        ],
        anonymous: false,
    },
] as const;
