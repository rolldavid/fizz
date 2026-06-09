/**
 * In-wallet L1 funding account — the bridge's L1 side, self-contained.
 *
 * Browser-extension popups never receive an injected provider, so the wallet
 * signs its own L1 transactions with a key derived from the user's phrase at
 * the STANDARD Ethereum path (recoverable in MetaMask — see vault/l1Account).
 *
 * Two ways to obtain fee juice (design: docs/FEE_JUICE_ALPHA.md):
 *   - "mint"  (testnet + sandbox): the network's L1 FeeAssetHandler mints a
 *     FIXED 1000-FJ batch for free — the funding account only needs a little
 *     ETH for gas. The intuitive default wherever a handler exists.
 *   - "asset" (alpha/mainnet, or holders of the L1 fee asset): approve +
 *     deposit the user's own AZTEC/fee-asset balance, any amount.
 */

import {
    createPublicClient,
    createWalletClient,
    formatEther,
    http,
    type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, foundry, mainnet } from "viem/chains";
import { vaultStore } from "../vault/store";
import { l1PrivateKeyToHex } from "../vault/l1Account";
import type { AztecWallet } from "./wallet";
import type { AztecNetwork } from "./networks";
import { SANDBOX_MINT_AMOUNT, bridgeFeeJuice, type EthereumProvider, type PendingBridge } from "./bridge";

const ERC20_ABI = [
    {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ type: "uint256" }],
    },
    {
        name: "symbol",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
] as const;

export function l1ChainFor(network: AztecNetwork) {
    if (network.l1ChainId === sepolia.id) return sepolia;
    if (network.l1ChainId === mainnet.id) return mainnet;
    return { ...foundry, id: network.l1ChainId };
}

export function l1RpcUrlFor(network: AztecNetwork): string {
    if (network.l1RpcUrl) return network.l1RpcUrl;
    throw new Error(`No L1 RPC configured for network ${network.id}.`);
}

/** The wallet's own L1 address (requires unlocked vault). */
export function getL1FundingAddress(): `0x${string}` {
    const key = vaultStore.getL1Key();
    return privateKeyToAccount(l1PrivateKeyToHex(key)).address;
}

export type L1FundingStatus = {
    address: `0x${string}`;
    eth: bigint;
    ethFormatted: string;
    feeAsset: bigint;
    feeAssetFormatted: string;
    feeAssetSymbol: string;
    /** True when the network's handler can mint the fee asset for free. */
    canMint: boolean;
};

function publicClient(network: AztecNetwork): PublicClient {
    return createPublicClient({ chain: l1ChainFor(network), transport: http(l1RpcUrlFor(network)) });
}

export async function getL1FundingStatus(
    wallet: AztecWallet,
    network: AztecNetwork,
): Promise<L1FundingStatus> {
    const address = getL1FundingAddress();
    const client = publicClient(network);
    const { l1ContractAddresses } = await (wallet as any).aztecNode.getNodeInfo();
    const feeAssetAddr = l1ContractAddresses.feeJuiceAddress?.toString() as `0x${string}`;
    if (!feeAssetAddr) throw new Error("Node did not report an L1 fee-asset address.");
    const handler = l1ContractAddresses.feeAssetHandlerAddress;

    const [eth, feeAsset, symbol] = await Promise.all([
        client.getBalance({ address }),
        client.readContract({
            address: feeAssetAddr,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [address],
        }),
        client
            .readContract({ address: feeAssetAddr, abi: ERC20_ABI, functionName: "symbol" })
            .catch(() => "AZTEC"),
    ]);

    return {
        address,
        eth,
        ethFormatted: Number(formatEther(eth)).toFixed(4),
        feeAsset,
        feeAssetFormatted: Number(formatEther(feeAsset)).toFixed(2),
        feeAssetSymbol: symbol as string,
        canMint: handler != null && !handler.isZero?.(),
    };
}

/**
 * EIP-1193 provider backed by the in-wallet L1 key. eth_sendTransaction is
 * signed locally and broadcast over plain RPC — exactly what MetaMask would
 * do, minus MetaMask.
 */
export function fundingAccountProvider(network: AztecNetwork): EthereumProvider {
    const key = vaultStore.getL1Key();
    const account = privateKeyToAccount(l1PrivateKeyToHex(key));
    const chain = l1ChainFor(network);
    const rpc = l1RpcUrlFor(network);
    const walletClient = createWalletClient({ account, chain, transport: http(rpc) });
    const reader = createPublicClient({ chain, transport: http(rpc) });
    return {
        async request({ method, params = [] }) {
            if (method === "eth_requestAccounts" || method === "eth_accounts") {
                return [account.address];
            }
            if (method === "eth_sendTransaction") {
                const tx = (params as any[])[0] ?? {};
                return walletClient.sendTransaction({
                    to: tx.to,
                    data: tx.data,
                    value: tx.value ? BigInt(tx.value) : undefined,
                    gas: tx.gas ? BigInt(tx.gas) : undefined,
                });
            }
            return reader.request({ method: method as any, params: params as any });
        },
    };
}

export type BridgeMode = "mint" | "asset";

/**
 * Bridge fee juice to `recipient` using the in-wallet funding account.
 *  - mode "mint": free fixed batch from the handler (needs only L1 gas).
 *  - mode "asset": deposits `amount` of the user's own L1 fee-asset balance.
 */
export async function bridgeFromFundingAccount(args: {
    wallet: AztecWallet;
    network: AztecNetwork;
    recipient: Parameters<typeof bridgeFeeJuice>[0]["recipient"];
    mode: BridgeMode;
    amount?: bigint;
}): Promise<PendingBridge> {
    const { wallet, network, recipient, mode } = args;
    const amount = mode === "mint" ? SANDBOX_MINT_AMOUNT : args.amount;
    if (!amount || amount <= 0n) throw new Error("Bridge amount must be greater than zero.");
    return bridgeFeeJuice({
        wallet,
        network,
        recipient,
        amount,
        provider: fundingAccountProvider(network),
        mint: mode === "mint",
    });
}
