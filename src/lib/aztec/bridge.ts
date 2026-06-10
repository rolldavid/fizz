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

import {
    createPublicClient,
    createWalletClient,
    custom,
    getContract,
    http,
    parseEventLogs,
    publicActions,
} from "viem";
import { mainnet, sepolia, foundry } from "viem/chains";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/foundation/curves/bn254";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { getNonNullifiedL1ToL2MessageWitness } from "@aztec/stdlib/messaging";
import type { AztecWallet } from "./wallet";
import type { AztecNetwork } from "./networks";
import { KEYS } from "../storage";
import { secureGet, secureSet } from "../secureStorage";

// LAZY by necessity, not style: pulling @aztec/aztec.js/ethereum + the
// l1-artifacts ABIs into the popup's STATIC graph (the straightforward
// `import`) shipped a build where synthesized input events and screenshots
// hang at onboarding (compositor/lifecycle stall — gate runs smoke25/26).
// These only load when a bridge function actually runs.
const lazyEthereum = () => import("@aztec/aztec.js/ethereum");
const lazyHash = () => import("@aztec/stdlib/hash");
const lazyPortalAbi = async () => (await import("@aztec/l1-artifacts/FeeJuicePortalAbi")).FeeJuicePortalAbi;
const lazyHandlerAbi = async () => (await import("@aztec/l1-artifacts/FeeAssetHandlerAbi")).FeeAssetHandlerAbi;
const lazyErc20Abi = async () => (await import("@aztec/l1-artifacts/TestERC20Abi")).TestERC20Abi;

/**
 * Lifecycle of a bridge deposit. The claim SECRET is persisted in the
 * "depositing" state — BEFORE any L1 transaction is broadcast — because the
 * secret is the only way to redeem the L1→L2 message. If this page dies
 * mid-flow (the toolbar popup closes on blur), nothing redeemable is ever
 * lost:
 *
 *   depositing → nothing on-chain yet (at worst a mint/approve landed —
 *                recoverable funds on the L1 funding address). Dismissable.
 *   sent       → depositToAztecPublic broadcast; receipt pending. Recovery
 *                (`recoverInFlightBridges`) finishes the bookkeeping from the
 *                receipt on the next visit.
 *   pending    → message confirmed on L1, claim fields complete; waiting to
 *                be consumable on L2 (listReadyClaims).
 *   failed     → the deposit tx reverted. Dismissable.
 */
export type BridgeStatus = "depositing" | "sent" | "pending" | "failed";

export type PendingBridge = {
    id: string;
    network: AztecNetwork["id"];
    recipient: string;
    claimAmount: string; // bigint as string
    claimSecret: string; // hex
    /** Set once the deposit is confirmed on L1 (status "pending"). */
    messageLeafIndex?: string; // bigint as string
    messageHash?: string;
    /** Entries persisted before this field existed are complete ("pending"). */
    status?: BridgeStatus;
    /** L1 tx hash of depositToAztecPublic, recorded at broadcast. */
    l1TxHash?: string;
    createdAt: number;
    consumedAt?: number;
    dismissedAt?: number;
};

/** Complete, unspent, undismissed — the only entries a fee payment may use. */
export function isClaimable(b: PendingBridge): boolean {
    return (
        (b.status ?? "pending") === "pending" &&
        !!b.messageHash &&
        !!b.messageLeafIndex &&
        !b.consumedAt &&
        !b.dismissedAt
    );
}

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

/** Insert or replace (by id) and persist. Newest first. */
async function upsertBridge(entry: PendingBridge): Promise<void> {
    const all = (await secureGet<PendingBridge[]>(KEYS.pendingBridges)) ?? [];
    const idx = all.findIndex((b) => b.id === entry.id);
    const next = idx >= 0 ? all.map((b) => (b.id === entry.id ? entry : b)) : [entry, ...all];
    await secureSet(KEYS.pendingBridges, next);
}

const normalizeHex = (v: string | bigint | number) => {
    const s = typeof v === "string" ? v : `0x${v.toString(16).padStart(64, "0")}`;
    return s.toLowerCase();
};

/**
 * Find this deposit's DepositToAztecPublic event in a mined receipt and
 * complete the entry from it. Throws if absent — a deposit receipt without
 * its event means something is deeply wrong; never mark such a claim usable.
 */
async function completeFromReceipt(
    entry: PendingBridge,
    receipt: { logs: any[] },
    portalAddress: string,
    claimSecretHash: string,
): Promise<PendingBridge> {
    const events = parseEventLogs({
        abi: await lazyPortalAbi(),
        logs: receipt.logs as any,
        eventName: "DepositToAztecPublic",
    }) as any[];
    const match = events.find(
        (log) =>
            log.address.toLowerCase() === portalAddress.toLowerCase() &&
            normalizeHex(log.args.secretHash) === normalizeHex(claimSecretHash),
    );
    if (!match) {
        throw new Error(
            "Deposit transaction mined but its DepositToAztecPublic event was not found — " +
                "refusing to record an unverifiable claim.",
        );
    }
    return {
        ...entry,
        status: "pending",
        messageHash: match.args.key as string,
        messageLeafIndex: (match.args.index as bigint).toString(),
    };
}

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
    const l1Account = accounts[0] as `0x${string}`;

    const chain = chainForL1(network.l1ChainId);
    const client = createWalletClient({
        account: l1Account,
        chain,
        transport: custom(provider),
    }).extend(publicActions);

    const node = (wallet as any).aztecNode;
    if (!node) throw new Error("Aztec wallet has no node attached.");
    const { l1ContractAddresses } = await node.getNodeInfo();
    const portalAddress = l1ContractAddresses.feeJuicePortalAddress?.toString() as `0x${string}`;
    const feeAssetAddress = l1ContractAddresses.feeJuiceAddress?.toString() as `0x${string}`;
    if (!portalAddress || !feeAssetAddress) {
        throw new Error("Node did not report the L1 fee-juice portal/asset addresses.");
    }

    // The secret is generated HERE and persisted BEFORE any L1 transaction is
    // broadcast. The previous flow (SDK portal manager) generated it
    // internally and only surfaced it after mining — a page death in that
    // window lost the secret and stranded the deposited funds forever.
    const { generateClaimSecret } = await lazyEthereum();
    const [claimSecret, claimSecretHash] = await generateClaimSecret();
    let entry: PendingBridge = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        network: network.id,
        recipient: recipient.toString(),
        claimAmount: amount.toString(),
        claimSecret: claimSecret.toString(),
        status: "depositing",
        createdAt: Date.now(),
    };
    await upsertBridge(entry);

    if (mint) {
        const handlerAddress = l1ContractAddresses.feeAssetHandlerAddress?.toString() as
            | `0x${string}`
            | undefined;
        if (!handlerAddress) {
            throw new Error("This network has no free fee-asset handler — bridge your own balance.");
        }
        const handler = getContract({ address: handlerAddress, abi: await lazyHandlerAbi(), client });
        const mintAmount = (await handler.read.mintAmount()) as bigint;
        if (amount !== mintAmount) {
            throw new Error(`The network's handler mints exactly ${mintAmount} per call.`);
        }
        await client.waitForTransactionReceipt({
            hash: await handler.write.mint([l1Account]),
        });
    }

    const feeAsset = getContract({ address: feeAssetAddress, abi: await lazyErc20Abi(), client });
    await client.waitForTransactionReceipt({
        hash: await feeAsset.write.approve([portalAddress, amount]),
    });

    const portal = getContract({ address: portalAddress, abi: await lazyPortalAbi(), client });
    const depositArgs = [recipient.toString(), amount, claimSecretHash.toString()] as const;
    await portal.simulate.depositToAztecPublic(depositArgs as any);
    const l1TxHash = await portal.write.depositToAztecPublic(depositArgs as any);

    // Record the broadcast before waiting: if we die here, recovery completes
    // the claim from the receipt on the next visit.
    entry = { ...entry, status: "sent", l1TxHash };
    await upsertBridge(entry);

    const receipt = await client.waitForTransactionReceipt({ hash: l1TxHash });
    if (receipt.status !== "success") {
        entry = { ...entry, status: "failed" };
        await upsertBridge(entry);
        throw new Error(`L1 deposit transaction reverted (${l1TxHash}).`);
    }

    entry = await completeFromReceipt(entry, receipt, portalAddress, claimSecretHash.toString());
    await upsertBridge(entry);
    return entry;
}

/**
 * Finish bookkeeping for deposits whose page died between broadcast and
 * receipt ("sent"): fetch the receipt from L1 and complete or fail the entry.
 * Read-only on L1 — safe to call on every Bridge visit.
 */
export async function recoverInFlightBridges(
    networkId: AztecNetwork["id"],
    l1RpcUrl: string,
    portalAddress: string,
): Promise<void> {
    const all = (await secureGet<PendingBridge[]>(KEYS.pendingBridges)) ?? [];
    const stuck = all.filter(
        (b) => b.network === networkId && b.status === "sent" && b.l1TxHash && !b.dismissedAt,
    );
    if (stuck.length === 0) return;

    const client = createPublicClient({ transport: http(l1RpcUrl) });
    for (const b of stuck) {
        let receipt;
        try {
            receipt = await client.getTransactionReceipt({ hash: b.l1TxHash as `0x${string}` });
        } catch {
            continue; // not mined yet (or RPC hiccup) — try again next visit
        }
        if (receipt.status !== "success") {
            await upsertBridge({ ...b, status: "failed" });
            continue;
        }
        const { computeSecretHash } = await lazyHash();
        const secretHash = await computeSecretHash(Fr.fromHexString(b.claimSecret));
        await upsertBridge(await completeFromReceipt(b, receipt, portalAddress, secretHash.toString()));
    }
}

/** Hide an unrecoverable entry (interrupted pre-broadcast, or reverted). */
export async function dismissBridge(id: string): Promise<void> {
    const all = (await secureGet<PendingBridge[]>(KEYS.pendingBridges)) ?? [];
    await secureSet(
        KEYS.pendingBridges,
        all.map((b) => (b.id === id ? { ...b, dismissedAt: Date.now() } : b)),
    );
}

export async function listPendingBridges(networkId: AztecNetwork["id"]): Promise<PendingBridge[]> {
    const all = (await secureGet<PendingBridge[]>(KEYS.pendingBridges)) ?? [];
    return all.filter((b) => b.network === networkId && !b.consumedAt && !b.dismissedAt);
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
    // In-flight ("depositing"/"sent") and failed entries are never offered to
    // fee payments — only claims completed from a confirmed L1 receipt.
    const mine = (await listPendingBridges(networkId)).filter(
        (b) => b.recipient === recip && isClaimable(b),
    );
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
                Fr.fromHexString(b.messageHash!), // isClaimable guarantees set
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
