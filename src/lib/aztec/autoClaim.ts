/**
 * Background bridge bookkeeping (NOT eager claiming).
 *
 * Bridged fee juice is consumed LAZILY: the user's first transaction pays its
 * fee with the claim (resolveFeePaymentMethod prefers a consumable claim, and
 * ensureAccountDeployed deploys the account paying with it on the very first
 * send). Nothing about a confirmed claim is time-sensitive, so the user does
 * NOT have to keep the wallet open for gas to become usable — the Home screen
 * shows the bridged amount as incoming, and the first send sweeps it in.
 *
 * What this engine still does on a tick (all cheap, all idempotent):
 *   - adopt a deposit the web bridge reported while no wallet window was open
 *     (the report waits in storage.local, surviving browser restarts);
 *   - advance "sent" entries by verifying their L1 receipts (recoverInFlight);
 *   - settle a legacy in-flight landing tx from the old eager-claim model;
 *   - resume an interrupted account deployment (journal reconcile), so a
 *     deploy that broadcast before the popup died finishes its bookkeeping.
 *
 * Listeners (Home's gas line + notice modal, the Bridge screen) are pinged
 * whenever any of that changes claim state.
 */

import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/foundation/curves/bn254";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { computeL1ToL2MessageNullifier } from "@aztec/stdlib/hash";
import { MerkleTreeId } from "@aztec/stdlib/trees";
import { TxExecutionResult, TxHash, TxStatus } from "@aztec/stdlib/tx";
import type { AztecWallet } from "./wallet";
import type { AztecNetwork } from "./networks";
import { hasActiveOps } from "../state/activity";
import { clearBridgeDeposit, readBridgeDeposit } from "../state/bridgeHandoff";
import { loadPendingDeploy } from "./accountDeploy";
import { isClaimRecoveryDone, recoverBridgedClaims } from "./claimRecovery";
import {
    clearClaimTxBroadcast,
    listPendingBridges,
    markBridgeConsumed,
    recordBridgeDeposit,
    recoverInFlightBridges,
    type PendingBridge,
} from "./bridge";

// The node answers DROPPED for any hash it doesn't know, including a tx that
// hasn't gossiped to this node (or load-balancer instance) yet. Only believe
// DROPPED for a broadcast younger than this.
const DROPPED_GRACE_MS = 10 * 60_000;

// "Claim state changed" notifications, so open screens (Home gas line + gas
// notice, Bridge list) can repaint without polling.
const landedListeners = new Set<() => void>();
export function onFeeJuiceLanded(listener: () => void): () => void {
    landedListeners.add(listener);
    return () => landedListeners.delete(listener);
}
function emitLanded(): void {
    for (const l of [...landedListeners]) l();
}

/**
 * Settle a landing tx broadcast by the old eager-claim model (claimTxHash on
 * the entry). Returns true when the entry reached a terminal state.
 */
async function reconcileBroadcast(wallet: AztecWallet, b: PendingBridge): Promise<boolean> {
    const receipt = await (wallet as any).aztecNode.getTxReceipt(TxHash.fromString(b.claimTxHash!));

    if (receipt.status === TxStatus.PENDING) return false;
    if (receipt.status === TxStatus.DROPPED) {
        if (Date.now() - (b.claimTxBroadcastAt ?? 0) < DROPPED_GRACE_MS) return false;
        await clearClaimTxBroadcast(b.id);
        console.error(
            `Fee-juice landing tx ${b.claimTxHash} for claim ${b.id} was dropped; ` +
                "the claim is back in the pool and will pay the next outgoing tx.",
        );
        return true;
    }
    // Included in a block (proposed or later).
    if (receipt.executionResult === TxExecutionResult.SUCCESS) {
        await markBridgeConsumed(b.id);
    } else {
        await clearClaimTxBroadcast(b.id);
        console.error(
            `Fee-juice landing tx ${b.claimTxHash} for claim ${b.id} reverted ` +
                `(${receipt.executionResult}); the claim is back in the pool.`,
        );
    }
    return true;
}

const stateKey = (mine: PendingBridge[]) =>
    mine.map((b) => `${b.id}:${b.status}:${b.consumedAt ?? 0}:${b.claimTxHash ?? ""}`).join("|");

/**
 * One bookkeeping pass. Cheap when idle: no node traffic until a deposit
 * report or a local pending entry exists.
 */
export async function autoClaimTick(args: {
    wallet: AztecWallet;
    network: AztecNetwork;
    recipient: AztecAddress;
    isDeployed: boolean;
    /** walletContext's deploy — used only to RESUME an interrupted deployment. */
    ensureAccountDeployed: () => Promise<void>;
    /** For the once-per-install seed recovery scan (claimRecovery). */
    seed?: Uint8Array;
    accountIndex?: number;
}): Promise<void> {
    const { wallet, network, recipient, isDeployed, ensureAccountDeployed } = args;
    const recip = recipient.toString();

    // Once per (network, account) per install: scan L1 for seed-derived claims
    // this install doesn't know about (fresh import / reinstall). Marked done
    // only on success, so a failed scan retries next tick.
    if (
        args.seed &&
        args.accountIndex !== undefined &&
        network.l1RpcUrl &&
        !(await isClaimRecoveryDone(network.id, recip))
    ) {
        try {
            const result = await recoverBridgedClaims({
                wallet,
                network,
                seed: args.seed,
                accountIndex: args.accountIndex,
                recipient,
            });
            if (result.recovered > 0) emitLanded();
        } catch (err) {
            // Best-effort, once-per-install: an unhealthy L1 RPC must not hold
            // the load-bearing paths below (deposit adoption, deploy resume)
            // hostage. The done-flag is only set on success, so this retries
            // on the next tick.
            console.error("Bridge claim recovery scan failed (will retry):", err);
        }
    }

    // A deployment journaled by an earlier session reconciles first — its tx
    // may have landed (flip isDeployed + finish claim bookkeeping) or still be
    // in flight (wait on it; never prove a duplicate).
    if (!isDeployed && (await loadPendingDeploy(network.id, recip))) {
        if (hasActiveOps()) return;
        await ensureAccountDeployed();
        emitLanded();
        return;
    }

    // Adopt a deposit the web bridge reported while no wallet window was on
    // the Bridge screen (storage.local — survives restarts).
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

    let mine = (await listPendingBridges(network.id)).filter((b) => b.recipient === recip);
    if (mine.length === 0) {
        if (dep) emitLanded();
        return;
    }
    const before = stateKey(mine);

    // Verify "sent" deposits against their L1 receipts → "pending" (the state
    // the first transaction's fee resolution consumes).
    if (mine.some((b) => b.status === "sent" && b.l1TxHash) && network.l1RpcUrl) {
        const { l1ContractAddresses } = await (wallet as any).aztecNode.getNodeInfo();
        const portal = l1ContractAddresses.feeJuicePortalAddress?.toString();
        if (portal) {
            await recoverInFlightBridges(network.id, network.l1RpcUrl, portal);
        }
    }

    // Settle landing txs from the old eager model, if any are still around.
    for (const b of mine.filter((x) => x.claimTxHash && !x.consumedAt)) {
        await reconcileBroadcast(wallet, b);
    }

    // Nullification sweep: a "pending" claim whose message was consumed
    // ELSEWHERE (same seed on another install, or a lost consumed-flag) would
    // sit in the optimistic gas number forever while the balance also holds
    // its value — a permanent double count.
    //
    // We mark consumed ONLY on a POSITIVELY confirmed on-chain nullifier.
    // markBridgeConsumed is irreversible (and the recovery dedupe then blocks
    // re-adoption), so it must never fire on ambiguous evidence:
    // getNonNullifiedL1ToL2MessageWitness throws for THREE indistinguishable
    // reasons — message absent, nullifier present, OR a transient node error in
    // its internal Promise.all — and "is the message in the tree right now?" is
    // ALSO not proof of a spend (a freshly-synced UNspent claim is in-tree).
    // Inferring consumption from either would let a lying node, or even
    // ordinary sync/RPC timing, permanently strand a real funded claim. So we
    // compute the claim's nullifier and look it up in the NULLIFIER_TREE
    // directly: only a present leaf proves the claim was actually spent.
    const node = (wallet as any).aztecNode;
    const feeJuiceAddress = FeeJuiceContract.at(wallet as any).address;
    for (const b of mine.filter(
        (x) => (x.status ?? "pending") === "pending" && x.messageHash && !x.consumedAt && !x.claimTxHash,
    )) {
        // Parse the stored fields ONCE, under a guard: a malformed entry must
        // never abort the whole tick (one did — its messageHash parsed badly,
        // and the re-parse inside the old catch threw synchronously, killing
        // every subsequent tick with "Tried to create a Fr from an invalid
        // string: [object Object]").
        let messageHash: Fr;
        let claimSecret: Fr;
        try {
            messageHash = Fr.fromHexString(b.messageHash!);
            claimSecret = Fr.fromHexString(b.claimSecret);
        } catch (err) {
            console.error(
                `Claim ${b.id} is malformed and was skipped by the sweep. ` +
                    `messageHash=${JSON.stringify(b.messageHash)} ` +
                    `claimSecretType=${typeof b.claimSecret} status=${b.status} ` +
                    `createdAt=${new Date(b.createdAt).toISOString()}`,
                err,
            );
            continue;
        }
        let nullifier: Fr;
        try {
            nullifier = await computeL1ToL2MessageNullifier(feeJuiceAddress, messageHash, claimSecret);
        } catch (err) {
            // Can't derive the nullifier (e.g. a malformed field slipped the
            // parse guard above) — never consume on a derivation failure.
            console.error(`Claim ${b.id}: could not compute nullifier; left untouched.`, err);
            continue;
        }
        // findLeavesIndexes returns a sparse array: a defined index at [0]
        // means the nullifier leaf EXISTS, i.e. the claim was provably spent.
        // Anything else (undefined, or a thrown RPC error that propagates and
        // ends this tick) leaves the claim pending for a later, cleaner tick —
        // never a false irreversible consume.
        const [idx] = await node.findLeavesIndexes("latest", MerkleTreeId.NULLIFIER_TREE, [
            nullifier,
        ]);
        if (idx !== undefined) {
            console.info(`Claim ${b.id}: nullifier present on-chain — marking consumed.`);
            await markBridgeConsumed(b.id);
        }
    }

    mine = (await listPendingBridges(network.id)).filter((b) => b.recipient === recip);
    if (stateKey(mine) !== before || dep) emitLanded();
}
