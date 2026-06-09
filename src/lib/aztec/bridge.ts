/**
 * L1 → L2 fee juice bridge.
 *
 * Flow:
 *   1. User connects an L1 wallet (window.ethereum / MetaMask).
 *   2. We wrap it with viem and call `L1FeeJuicePortalManager.bridgeTokensPublic(to, amount)`.
 *   3. The portal emits a `DepositToAztecPublic` event; we persist the resulting
 *      L2AmountClaim (claimAmount, claimSecret, messageLeafIndex, …) locally.
 *   4. After enough L1 blocks have passed for the message to be included on L2
 *      (typically a few minutes on real networks; near-instant on sandbox), the
 *      claim is ready. The next L2 transaction can pay fees with
 *      FeeJuicePaymentMethodWithClaim to consume the claim and pay gas in one shot,
 *      OR we can call FeeJuice.claim() directly to credit the balance.
 *
 * On sandbox, the fee juice handler can mint tokens to the user, so `mint=true`
 * is fine. On testnet/mainnet, the user must already hold the L1 fee juice token.
 */

import { custom, createWalletClient, publicActions } from "viem";
import { mainnet, sepolia, foundry } from "viem/chains";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/foundation/curves/bn254";
import { L1FeeJuicePortalManager } from "@aztec/aztec.js/ethereum";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { getNonNullifiedL1ToL2MessageWitness } from "@aztec/stdlib/messaging";
import { createLogger } from "@aztec/foundation/log";
import type { AztecWallet } from "./wallet";
import type { AztecNetwork } from "./networks";
import { KEYS } from "../storage";
import { secureGet, secureSet } from "../secureStorage";

export type PendingBridge = {
    id: string;
    network: AztecNetwork["id"];
    recipient: string;
    claimAmount: string; // bigint as string
    claimSecret: string; // hex
    messageLeafIndex: string; // bigint as string
    messageHash: string;
    createdAt: number;
    consumedAt?: number;
};

function chainForL1(chainId: number) {
    if (chainId === mainnet.id) return mainnet;
    if (chainId === sepolia.id) return sepolia;
    if (chainId === foundry.id) return foundry;
    // Fallback: foundry-like local chain
    return { ...foundry, id: chainId };
}

export type EthereumProvider = {
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

/**
 * The sandbox's L1 FeeAssetHandler mints a FIXED amount per call — requesting
 * any other amount reverts with "Minting amount must be …". So on sandbox the
 * bridge UI uses exactly this amount with `mint: true`.
 */
export const SANDBOX_MINT_AMOUNT = 1000n * 10n ** 18n;

export function getInjectedProvider(): EthereumProvider | null {
    const eth = (globalThis as any).ethereum;
    return eth && typeof eth.request === "function" ? eth : null;
}

/**
 * Direct JSON-RPC provider for L1 nodes with UNLOCKED accounts (the sandbox's
 * anvil). Browser extensions never receive an injected provider (MetaMask only
 * injects into web pages), so on sandbox we talk to anvil directly —
 * eth_sendTransaction works server-side because anvil's accounts are unlocked.
 * Never use this against a real network; real flows need a signing wallet.
 */
export function directRpcProvider(url: string): EthereumProvider {
    let id = 0;
    async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
        if (body.error) {
            throw new Error(`L1 RPC ${method} failed: ${body.error.message ?? "unknown error"}`);
        }
        return body.result;
    }
    return {
        async request({ method, params = [] }) {
            if (method === "eth_requestAccounts") return rpc("eth_accounts", []);
            return rpc(method, params);
        },
    };
}

export const SANDBOX_L1_RPC_URL = "http://localhost:8545";

export async function bridgeFeeJuice(args: {
    wallet: AztecWallet;
    network: AztecNetwork;
    recipient: AztecAddress;
    amount: bigint;
    provider: EthereumProvider;
    mint?: boolean;
}): Promise<PendingBridge> {
    const { wallet, network, recipient, amount, provider, mint = false } = args;

    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts?.[0]) throw new Error("No L1 account connected.");

    const chain = chainForL1(network.l1ChainId);
    const client = createWalletClient({
        account: accounts[0] as `0x${string}`,
        chain,
        transport: custom(provider),
    }).extend(publicActions);

    const node = (wallet as any).aztecNode;
    if (!node) throw new Error("Aztec wallet has no node attached.");

    const manager = await L1FeeJuicePortalManager.new(
        node,
        client as any,
        createLogger("wallet:bridge"),
    );
    const claim = await manager.bridgeTokensPublic(recipient, amount, mint);

    const entry: PendingBridge = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        network: network.id,
        recipient: recipient.toString(),
        claimAmount: claim.claimAmount.toString(),
        claimSecret: claim.claimSecret.toString(),
        messageLeafIndex: claim.messageLeafIndex.toString(),
        messageHash: claim.messageHash.toString(),
        createdAt: Date.now(),
    };

    const existing = (await secureGet<PendingBridge[]>(KEYS.pendingBridges)) ?? [];
    await secureSet(KEYS.pendingBridges, [entry, ...existing]);
    return entry;
}

export async function listPendingBridges(networkId: AztecNetwork["id"]): Promise<PendingBridge[]> {
    const all = (await secureGet<PendingBridge[]>(KEYS.pendingBridges)) ?? [];
    return all.filter((b) => b.network === networkId && !b.consumedAt);
}

/**
 * Pending claims that are safe to attach to a fee-paying tx: scoped to THIS
 * recipient (a claim bridged to account A can't pay for account B's tx — the
 * L1→L2 message encodes the recipient) AND provably present in the message
 * tree AT THE PXE'S OWN SYNCED BLOCK.
 *
 * That last part is load-bearing: the node-level "is synced" check
 * (`isL1ToL2MessageSynced`, now deprecated for exactly this reason) can return
 * true while the wallet's PXE — which simulates against its synced tip, e.g.
 * the PROVEN tip — still can't see the message, making the tx fail with
 * "No L1 to L2 message found". We ask for a membership witness at the PXE's
 * synced block: if one exists, simulation is guaranteed to find the message.
 */
export async function listReadyClaims(
    wallet: AztecWallet,
    networkId: AztecNetwork["id"],
    recipient: AztecAddress,
): Promise<PendingBridge[]> {
    const recip = recipient.toString();
    const mine = (await listPendingBridges(networkId)).filter((b) => b.recipient === recip);
    if (mine.length === 0) return [];
    const node = (wallet as any).aztecNode;
    const pxe = (wallet as any).pxe;

    // The PXE only advances its anchor block during private-state sync —
    // getSyncedBlockHeader alone does NOT sync, and neither do public-storage
    // utility reads. A wallet polling claim readiness would otherwise sit on a
    // stale anchor forever (witness queries against pruned blocks then fail
    // with "failed to get block data"). Drive the synchronizer explicitly;
    // verified against SDK 4.3.0. If the internal moves in an upgrade, fail
    // LOUDLY here rather than silently reporting claims unready forever.
    const synchronizer = (pxe as any).blockStateSynchronizer;
    if (typeof synchronizer?.sync !== "function") {
        throw new Error(
            "PXE internals changed: blockStateSynchronizer.sync() unavailable — " +
                "update listReadyClaims for this SDK version.",
        );
    }
    await synchronizer.sync();

    // Identify the EXACT view the simulation will use: the PXE's anchor block,
    // referenced BY HASH — the node serves witness lookups keyed by block hash
    // (the PXE oracle's own path); lookups by number fail with "failed to get
    // block data" on nodes that don't index historical snapshots that way.
    let anchorBlockHash: unknown;
    try {
        const syncedHeader = await pxe.getSyncedBlockHeader();
        anchorBlockHash = await syncedHeader.hash();
    } catch {
        // PXE hasn't anchored its first block yet (fresh wallet, quiet chain).
        // No claim can be consumed before that point — report none ready.
        return [];
    }
    // The claim's nullifier is keyed on the FeeJuice protocol contract.
    const feeJuiceAddress = FeeJuiceContract.at(wallet as any).address;

    const ready: PendingBridge[] = [];
    for (const b of mine) {
        try {
            // Throws when the message is absent OR already nullified (claimed).
            // Both must exclude the claim: membership alone would re-offer a
            // SPENT claim (e.g. after a reinstall loses the local consumed
            // flag), making the next tx fail at simulation.
            await getNonNullifiedL1ToL2MessageWitness(
                node,
                feeJuiceAddress,
                Fr.fromHexString(b.messageHash),
                Fr.fromHexString(b.claimSecret),
                anchorBlockHash as any,
            );
            ready.push(b);
        } catch {
            // Absent, not-yet-synced, or already claimed — not ready.
        }
    }
    return ready;
}

export async function markBridgeConsumed(id: string): Promise<void> {
    const all = (await secureGet<PendingBridge[]>(KEYS.pendingBridges)) ?? [];
    const next = all.map((b) => (b.id === id ? { ...b, consumedAt: Date.now() } : b));
    await secureSet(KEYS.pendingBridges, next);
}
