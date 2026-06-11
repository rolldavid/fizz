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
import { assertWithinU128 } from "./tokenContract";

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
    /**
     * L2 tx hash of the background landing tx (autoClaim), recorded at
     * broadcast — the engine sends with NO_WAIT and reconciles the receipt on
     * a later tick (or the next session), so the popup doesn't have to outlive
     * inclusion. While set, the claim is withheld from fee payments: the
     * landing tx will nullify the message, and attaching it to a user tx too
     * would fail both.
     */
    claimTxHash?: string;
    /** When the landing tx was broadcast. An unknown hash reads DROPPED on the
     * node (gossip/load-balancer lag), so DROPPED is only treated as terminal
     * after a grace window from this time. */
    claimTxBroadcastAt?: number;
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
        !b.claimTxHash && // a landing tx is in flight for it (see autoClaim)
        !b.consumedAt &&
        !b.dismissedAt
    );
}

/** Record the broadcast landing tx for a claim (withholds it from fee use). */
export async function markClaimTxBroadcast(id: string, txHash: string): Promise<void> {
    const all = (await secureGet<PendingBridge[]>(KEYS.pendingBridges)) ?? [];
    await secureSet(
        KEYS.pendingBridges,
        all.map((b) =>
            b.id === id ? { ...b, claimTxHash: txHash, claimTxBroadcastAt: Date.now() } : b,
        ),
    );
}

/** The landing tx died (dropped/reverted) — return the claim to the pool. */
export async function clearClaimTxBroadcast(id: string): Promise<void> {
    const all = (await secureGet<PendingBridge[]>(KEYS.pendingBridges)) ?? [];
    await secureSet(
        KEYS.pendingBridges,
        all.map((b) =>
            b.id === id ? { ...b, claimTxHash: undefined, claimTxBroadcastAt: undefined } : b,
        ),
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
            normalizeHex(log.args.secretHash) === normalizeHex(claimSecretHash) &&
            // Bind the recipient too: the L1→L2 message encodes (to, amount,
            // secretHash), and the claim circuit recomputes the key from the
            // SENDER. A deposit made to a different recipient with this secret
            // hash (a connected page could do that) would record a "pending"
            // claim that can never be spent — wedging every fee-paid tx. Refuse
            // to record any event whose recipient isn't ours.
            normalizeHex(log.args.to) === normalizeHex(entry.recipient),
    );
    if (!match) {
        // A mined SUCCESS receipt always carries its deposit event, so a missing
        // match is terminal (wrong recipient/secret hash, or not a deposit) —
        // tagged so recovery marks it failed rather than retrying forever, while
        // transient errors (chunk load, RPC/parse hiccup) stay retryable.
        const err = new Error(
            "Deposit transaction mined but no matching DepositToAztecPublic event (recipient + " +
                "secret hash) was found. Refusing to record an unverifiable claim.",
        );
        (err as Error & { unverifiable?: boolean }).unverifiable = true;
        throw err;
    }
    return {
        ...entry,
        status: "pending",
        // Trust the on-chain event for the amount, not any caller-supplied value:
        // a claim built with the wrong amount would never become spendable.
        claimAmount: (match.args.amount as bigint).toString(),
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
 * Auto-claim, step 1 (popup, unlocked): generate the claim secret for the
 * CONNECTED account and persist a "depositing" record BEFORE any L1 tx — the
 * secret is the only way to redeem the deposit, and it must never leave the
 * wallet. The web page (which holds the L1 wallet) then does the deposit with
 * the returned {recipient, secretHash}; only those two PUBLIC values cross the
 * connected channel (secretHash is written on-chain by the deposit anyway).
 */
export async function prepareBridgeClaim(args: {
    network: AztecNetwork;
    recipient: AztecAddress;
    amount: bigint;
}): Promise<{ id: string; recipient: string; secretHash: string }> {
    const { network, recipient, amount } = args;
    if (amount <= 0n) throw new Error("Bridge amount must be greater than zero.");
    // Bound the page-supplied amount: the real claim amount is re-bound from the
    // on-chain deposit event in completeFromReceipt, but keep our own confirm
    // card from ever showing a nonsensical (out-of-range) figure.
    assertWithinU128(amount);
    const { generateClaimSecret } = await lazyEthereum();
    const [claimSecret, claimSecretHash] = await generateClaimSecret();
    const entry: PendingBridge = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        network: network.id,
        recipient: recipient.toString(),
        claimAmount: amount.toString(),
        claimSecret: claimSecret.toString(),
        status: "depositing",
        createdAt: Date.now(),
    };
    await upsertBridge(entry);
    return { id: entry.id, recipient: entry.recipient, secretHash: claimSecretHash.toString() };
}

/**
 * Auto-claim, step 2 (popup): the web reports its L1 deposit landed. Locate the
 * matching "depositing" record by re-deriving its secret hash (NOT by trusting
 * a page-supplied id), then mark it "sent" with the tx hash. The existing
 * recoverInFlightBridges path then fetches the receipt, verifies the
 * DepositToAztecPublic event against this record (recipient + amount +
 * secretHash), and completes it — a fabricated tx hash simply never verifies,
 * and listReadyClaims is the final on-chain gate before anything is spendable.
 * Returns the record set to "sent", or null if no prepared record matches.
 */
export async function recordBridgeDeposit(args: {
    networkId: AztecNetwork["id"];
    secretHash: string;
    l1TxHash: string;
}): Promise<PendingBridge | null> {
    const { networkId, secretHash, l1TxHash } = args;
    if (!/^0x[0-9a-fA-F]{64}$/.test(l1TxHash)) throw new Error("Invalid L1 transaction hash.");
    const { computeSecretHash } = await lazyHash();
    const all = (await secureGet<PendingBridge[]>(KEYS.pendingBridges)) ?? [];
    for (const b of all) {
        if (b.network !== networkId || (b.status ?? "pending") !== "depositing") continue;
        const h = (await computeSecretHash(Fr.fromHexString(b.claimSecret))).toString();
        if (normalizeHex(h) !== normalizeHex(secretHash)) continue;
        const sent: PendingBridge = { ...b, status: "sent", l1TxHash };
        await upsertBridge(sent);
        return sent;
    }
    return null;
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
        // Per-entry isolation: a single un-completable entry (e.g. a tx that
        // mined but carries no matching deposit event) must not abort recovery
        // for every other in-flight bridge.
        let receipt;
        try {
            receipt = await client.getTransactionReceipt({ hash: b.l1TxHash as `0x${string}` });
        } catch (err) {
            // Only "no receipt yet" is the normal not-mined case — try again
            // next visit. Anything else (RPC unreachable, origin blocked by the
            // extension CSP, bad URL) must SURFACE: a blanket catch here once
            // ate CSP-blocked fetches for every testnet bridge, leaving claims
            // on "sent… check back in a minute" forever with no error shown.
            if ((err as { name?: string })?.name === "TransactionReceiptNotFoundError") continue;
            throw new Error(
                `Could not reach the L1 RPC (${l1RpcUrl}) to verify bridge deposit ${b.l1TxHash}: ` +
                    (err instanceof Error ? err.message : String(err)),
            );
        }
        try {
            if (receipt.status !== "success") {
                await upsertBridge({ ...b, status: "failed" });
                continue;
            }
            const { computeSecretHash } = await lazyHash();
            const secretHash = await computeSecretHash(Fr.fromHexString(b.claimSecret));
            await upsertBridge(await completeFromReceipt(b, receipt, portalAddress, secretHash.toString()));
        } catch (err) {
            if ((err as { unverifiable?: boolean })?.unverifiable) {
                // Terminal: a mined success receipt with no matching deposit
                // event is never spendable. Mark failed (dismissable) so it
                // stops being retried.
                console.error("Bridge recovery: unverifiable deposit, marking failed", b.id, err);
                await upsertBridge({ ...b, status: "failed" });
            } else {
                // Transient (chunk load, RPC/parse hiccup): leave "sent" so the
                // next visit retries — never strand a real, funded deposit.
                console.error("Bridge recovery: transient error, will retry", b.id, err);
            }
        }
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
 * Claims currently being spent by an in-flight transaction (the background
 * auto-claim). Excluded from listReadyClaims so a concurrent user-initiated tx
 * can't attach the same claim as its fee — the L1→L2 message nullifies on
 * first consumption, so a double-attach makes BOTH transactions fail.
 * Session-scoped by design: locks die with the popup, and an interrupted
 * claim's message witness check re-gates it on the next open.
 */
const claimsBeingSpent = new Set<string>();

/** Take the spend lock for a claim. False = someone else already holds it. */
export function lockClaimForSpend(id: string): boolean {
    if (claimsBeingSpent.has(id)) return false;
    claimsBeingSpent.add(id);
    return true;
}

export function releaseClaimSpendLock(id: string): void {
    claimsBeingSpent.delete(id);
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
    // fee payments — only claims completed from a confirmed L1 receipt. A
    // claim locked by an in-flight spend is excluded for the same reason.
    const mine = (await listPendingBridges(networkId)).filter(
        (b) => b.recipient === recip && isClaimable(b) && !claimsBeingSpent.has(b.id),
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
