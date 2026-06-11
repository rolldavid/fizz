/**
 * Background fee-juice landing.
 *
 * Bridged claims used to sit until the user's NEXT outgoing transaction
 * consumed them as its fee payment. That worked, but read as a bug: "I
 * bridged 100 and my balance still says 0". This engine makes the juice land
 * by itself while the popup is open — no button, no confirmation, no progress
 * UI. The gas line on Home just fills in.
 *
 * Per ready claim, one of two invisible transactions:
 *
 *   account not deployed  → deploy it NOW, paying the deployment with the
 *     claim (the canonical Aztec bootstrap — see e2e_smoke / spartan setup in
 *     aztec-packages). claim_and_end_setup credits the full bridged amount in
 *     the tx's setup phase, the deploy fee comes out of it, and the remainder
 *     is the visible balance. First gas doubles as account activation. This
 *     path WAITS for inclusion: ensureAccountDeployed is a shared primitive
 *     whose other callers (Send) require the account to actually exist.
 *
 *   account deployed → a claim-only tx, broadcast with NO_WAIT. With a
 *     sponsored FPC (testnet) the standalone FeeJuice.claim runs free and the
 *     FULL amount lands. Without one (mainnet) the tx pays for itself: the fee
 *     payment method's own payload (just claim_and_end_setup) IS the whole
 *     transaction, and amount − fee lands.
 *
 * NO_WAIT is the point: once the proof is broadcast, inclusion happens
 * on-chain whether or not this popup survives. The tx hash is persisted on
 * the entry at broadcast, and a later tick — possibly in a different session —
 * reconciles the receipt: success marks the claim consumed; dropped/reverted
 * returns it to the pool. So the wallet only needs to stay open through
 * PROVING (the 1–4 min part), not inclusion.
 *
 * Failure policy: a claim that fails to land is logged, left intact (it
 * remains a perfectly good next-tx fee payment — the old behaviour), and not
 * retried this session — client-side proving is far too expensive to put
 * inside a retry loop.
 */

import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/foundation/curves/bn254";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { NO_WAIT } from "@aztec/aztec.js/contracts";
import { TxExecutionResult, TxHash, TxStatus } from "@aztec/stdlib/tx";
import type { AztecWallet } from "./wallet";
import type { AztecNetwork } from "./networks";
import { hasActiveOps, trackOp } from "../state/activity";
import { clearBridgeDeposit, readBridgeDeposit } from "../state/bridgeHandoff";
import { loadPendingDeploy } from "./accountDeploy";
import { resolveSponsoredFeePaymentMethod } from "./fee";
import {
    clearClaimTxBroadcast,
    isClaimable,
    listPendingBridges,
    listReadyClaims,
    lockClaimForSpend,
    markBridgeConsumed,
    markClaimTxBroadcast,
    recordBridgeDeposit,
    recoverInFlightBridges,
    releaseClaimSpendLock,
    type PendingBridge,
} from "./bridge";

// The node answers DROPPED for any hash it doesn't know, including a tx that
// was broadcast seconds ago and hasn't gossiped to this node (or this
// load-balancer instance) yet. Only believe DROPPED after this long.
const DROPPED_GRACE_MS = 10 * 60_000;

// Claims that failed to auto-land this popup session. Never retried here
// (proving in a loop would burn the device); they stay listed as pending and
// the next user-initiated tx can still consume them as its fee.
const failedThisSession = new Set<string>();

// "Juice landed" notifications, so open screens (Home balance, Bridge list)
// can repaint without polling.
const landedListeners = new Set<() => void>();
export function onFeeJuiceLanded(listener: () => void): () => void {
    landedListeners.add(listener);
    return () => landedListeners.delete(listener);
}
function emitLanded(): void {
    for (const l of [...landedListeners]) l();
}

/**
 * Settle a previously broadcast landing tx from its receipt.
 * Returns true when the entry reached a terminal state (consumed or returned
 * to the pool); false while the tx is still in flight.
 */
async function reconcileBroadcast(wallet: AztecWallet, b: PendingBridge): Promise<boolean> {
    const receipt = await (wallet as any).aztecNode.getTxReceipt(TxHash.fromString(b.claimTxHash!));

    if (receipt.status === TxStatus.PENDING) return false;
    if (receipt.status === TxStatus.DROPPED) {
        if (Date.now() - (b.claimTxBroadcastAt ?? 0) < DROPPED_GRACE_MS) return false;
        await clearClaimTxBroadcast(b.id);
        failedThisSession.add(b.id);
        console.error(
            `Fee-juice landing tx ${b.claimTxHash} for claim ${b.id} was dropped; ` +
                "the claim is back in the pool and will pay the next outgoing tx.",
        );
        return true;
    }

    // Included in a block (proposed or later).
    if (receipt.executionResult === TxExecutionResult.SUCCESS) {
        await markBridgeConsumed(b.id);
        emitLanded();
    } else {
        // Reverted on-chain. Sponsored path only (the self-paid tx has no
        // revertible calls): the app-phase claim rolled back, the message is
        // NOT nullified, and the claim stays usable as a next-tx fee.
        await clearClaimTxBroadcast(b.id);
        failedThisSession.add(b.id);
        console.error(
            `Fee-juice landing tx ${b.claimTxHash} for claim ${b.id} reverted ` +
                `(${receipt.executionResult}); the claim is back in the pool.`,
        );
    }
    return true;
}

/** Prove + broadcast the claim-only tx; returns its hash without waiting. */
async function broadcastClaimOnlyTx(
    wallet: AztecWallet,
    recipient: AztecAddress,
    b: PendingBridge,
): Promise<string> {
    const claimAmount = BigInt(b.claimAmount);
    const claimSecret = Fr.fromHexString(b.claimSecret);
    const messageLeafIndex = BigInt(b.messageLeafIndex!); // isClaimable guarantees set

    const sponsored = await resolveSponsoredFeePaymentMethod(wallet);
    if (sponsored) {
        // Free path: the standalone (app-phase) FeeJuice.claim, fee sponsored —
        // the entire bridged amount lands.
        const feeJuice = FeeJuiceContract.at(wallet as any);
        const sent: any = await feeJuice.methods
            .claim(recipient, claimAmount, claimSecret, messageLeafIndex)
            .send({ from: recipient, fee: { paymentMethod: sponsored }, wait: NO_WAIT } as any);
        return sent.txHash.toString();
    }

    // Self-paying path (mainnet): the payment method's payload — a single
    // claim_and_end_setup call with the account as fee payer — is the whole
    // transaction. The wallet detects feePayer === from and builds the
    // entrypoint in FEE_JUICE_WITH_CLAIM mode; no app calls needed.
    const method = new FeeJuicePaymentMethodWithClaim(recipient, {
        claimAmount,
        claimSecret,
        messageLeafIndex,
    });
    const payload = await method.getExecutionPayload();
    const sent: any = await (wallet as any).sendTx(payload, { from: recipient, wait: NO_WAIT });
    return sent.txHash.toString();
}

/**
 * One pass of the engine: settle any landing tx already in flight, then — if
 * a claim for this account is ready on L2 — land it. At most one new
 * transaction per tick (claims are rare; a second ready claim lands on the
 * next tick). Cheap when idle — no node traffic until a local pending entry
 * exists.
 */
export async function autoClaimTick(args: {
    wallet: AztecWallet;
    network: AztecNetwork;
    recipient: AztecAddress;
    isDeployed: boolean;
    /** walletContext's deploy: resolves the claim as the deploy fee itself. */
    ensureAccountDeployed: () => Promise<void>;
}): Promise<void> {
    const { wallet, network, recipient, isDeployed, ensureAccountDeployed } = args;
    const recip = recipient.toString();

    // A deployment journaled by an earlier session reconciles FIRST — its tx
    // may have landed (flip isDeployed, mark its claim consumed) or still be
    // in flight (ensureAccountDeployed waits on it; never proves a duplicate).
    // This must not hide behind the claim gates below: once the deploy mined,
    // its claim is nullified on-chain and would never read "ready" again.
    if (!isDeployed && (await loadPendingDeploy(network.id, recip))) {
        if (hasActiveOps()) return;
        await ensureAccountDeployed();
        emitLanded();
        return;
    }

    // Adopt a deposit the web bridge reported while no wallet window was on
    // the Bridge screen, then finish "sent" entries from their L1 receipts.
    // Both used to run only on the Bridge screen's mount — moved here so that
    // screen is purely the hand-off window, not load-bearing plumbing (users
    // now go straight to fizzwallet.com/bridge from Home).
    const dep = await readBridgeDeposit();
    if (dep) {
        const sent = await recordBridgeDeposit({
            networkId: network.id,
            secretHash: dep.secretHash,
            l1TxHash: dep.l1TxHash,
        });
        // Only consume the slot when it matched a prepared claim here — it may
        // belong to a claim prepared on another network.
        if (sent) await clearBridgeDeposit();
    }

    // Local-storage gate first — zero network cost on the common empty case.
    let mine = (await listPendingBridges(network.id)).filter((b) => b.recipient === recip);
    if (mine.some((b) => b.status === "sent" && b.l1TxHash) && network.l1RpcUrl) {
        const { l1ContractAddresses } = await (wallet as any).aztecNode.getNodeInfo();
        const portal = l1ContractAddresses.feeJuicePortalAddress?.toString();
        if (portal) {
            await recoverInFlightBridges(network.id, network.l1RpcUrl, portal);
            mine = (await listPendingBridges(network.id)).filter((b) => b.recipient === recip);
        }
    }
    if (mine.length === 0) return;

    // Settle broadcasts from earlier ticks / sessions before starting new work.
    for (const b of mine.filter((x) => x.claimTxHash && !x.consumedAt)) {
        const settled = await reconcileBroadcast(wallet, b);
        if (!settled) return; // landing tx still in flight — nothing more to do
    }

    const candidates = mine.filter((b) => isClaimable(b) && !failedThisSession.has(b.id));
    if (candidates.length === 0) return;

    // Never compete with a user-initiated operation for the prover — and an
    // in-flight send may be about to consume one of these claims as its fee.
    if (hasActiveOps()) return;

    const ready = await listReadyClaims(wallet, network.id, recipient);
    const claim = ready.find((b) => !failedThisSession.has(b.id));
    if (!claim) return; // L1→L2 message not consumable yet — next tick

    if (!isDeployed) {
        // First gas on a fresh account: deployment IS the landing tx.
        // ensureAccountDeployed resolves this ready claim as the deploy's fee
        // payment and marks the bridge consumed; the claimed remainder becomes
        // the account's public balance. No lock here — the deploy path goes
        // through listReadyClaims itself and must be able to see the claim.
        try {
            await ensureAccountDeployed();
        } catch (err) {
            failedThisSession.add(claim.id);
            throw err;
        }
        emitLanded();
        return;
    }

    if (!lockClaimForSpend(claim.id)) return;
    try {
        // trackOp defers the idle auto-lock through proving — locking mid-proof
        // tears down the PXE. It ends at BROADCAST: from there the chain takes
        // over, and a later tick (any session) reconciles the receipt.
        const txHash = await trackOp(() => broadcastClaimOnlyTx(wallet, recipient, claim));
        await markClaimTxBroadcast(claim.id, txHash);
    } catch (err) {
        failedThisSession.add(claim.id);
        throw err;
    } finally {
        releaseClaimSpendLock(claim.id);
    }
}
