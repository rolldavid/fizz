/**
 * Journal of in-flight account deployments, written at BROADCAST.
 *
 * An account deployment is proven client-side (minutes) and then waits 1–3
 * blocks for inclusion. If the popup dies anywhere in that window, the next
 * session has no way to tell "deploy in flight" from "never deployed" — it
 * would prove a DUPLICATE deployment that burns minutes and then fails on the
 * initialization nullifier, and the bridge claim that paid the original
 * deploy would sit as a stuck "pending" card forever (its L1→L2 message
 * nullified on-chain, its local entry never marked consumed).
 *
 * So the deploy tx hash (and the claim id that paid for it) is journaled the
 * moment it's broadcast. `settlePriorDeploy` then reconciles on return:
 * landed → finish the claim bookkeeping; still settling → wait on the SAME
 * tx; provably dead → clear and let the caller deploy fresh. Every user flow
 * (Send / Mint / Convert / token Deploy) and the background auto-claim engine
 * funnel through walletContext.ensureAccountDeployed, which runs this first.
 */

import { TxHash, TxStatus } from "@aztec/stdlib/tx";
import type { AztecWallet } from "./wallet";
import type { AztecNetwork } from "./networks";
import { KEYS } from "../storage";
import { secureGet, secureSet } from "../secureStorage";
import { markBridgeConsumed } from "./bridge";

export type PendingAccountDeploy = {
    network: AztecNetwork["id"];
    /** The account being deployed. */
    address: string;
    /** L2 tx hash of the deployment, recorded at broadcast. */
    txHash: string;
    /** Bridge claim consumed as the deploy's fee. Marked consumed once the tx
     * is INCLUDED — even reverted: a claim-paid setup phase is non-revertible,
     * so the message is nullified and the juice landed regardless. */
    bridgeId?: string;
    broadcastAt: number;
};

// The node answers DROPPED for any hash it doesn't know, including a tx that
// hasn't gossiped to this node (or load-balancer instance) yet. Only believe
// DROPPED for a broadcast younger than this.
const DROPPED_GRACE_MS = 10 * 60_000;

export async function loadPendingDeploy(
    network: AztecNetwork["id"],
    address: string,
): Promise<PendingAccountDeploy | null> {
    const all = (await secureGet<PendingAccountDeploy[]>(KEYS.pendingAccountDeploys)) ?? [];
    return all.find((d) => d.network === network && d.address === address) ?? null;
}

export async function recordPendingDeploy(entry: PendingAccountDeploy): Promise<void> {
    const rest = ((await secureGet<PendingAccountDeploy[]>(KEYS.pendingAccountDeploys)) ?? []).filter(
        (d) => !(d.network === entry.network && d.address === entry.address),
    );
    await secureSet(KEYS.pendingAccountDeploys, [entry, ...rest]);
}

export async function clearPendingDeploy(
    network: AztecNetwork["id"],
    address: string,
): Promise<void> {
    const all = (await secureGet<PendingAccountDeploy[]>(KEYS.pendingAccountDeploys)) ?? [];
    await secureSet(
        KEYS.pendingAccountDeploys,
        all.filter((d) => !(d.network === network && d.address === address)),
    );
}

/**
 * Settle a previously broadcast deployment. Returns true when the account is
 * now deployed (claim bookkeeping done, journal cleared); false when the tx
 * was provably dead and cleared — the caller should deploy fresh. THROWS
 * while the tx is still settling (in the mempool, or DROPPED-but-too-young):
 * redeploying in that state would double-spend minutes of proving on a tx
 * doomed by the original's nullifier.
 */
export async function settlePriorDeploy(
    wallet: AztecWallet,
    rec: PendingAccountDeploy,
): Promise<boolean> {
    const { waitForTx } = await import("@aztec/aztec.js/node");
    const node = (wallet as any).aztecNode;
    const txHash = TxHash.fromString(rec.txHash);
    try {
        await waitForTx(node, txHash);
    } catch (err) {
        const receipt = await node.getTxReceipt(txHash);
        if (receipt.status === TxStatus.PENDING) throw err; // wait timed out — still in flight
        if (receipt.status === TxStatus.DROPPED) {
            if (Date.now() - rec.broadcastAt < DROPPED_GRACE_MS) throw err; // maybe gossip lag
            // Genuinely dead: nothing landed, the claim (if any) was never
            // consumed and is still spendable. Deploy fresh.
            await clearPendingDeploy(rec.network, rec.address);
            return false;
        }
        // Included but reverted. The fee still settled — a claim-paid setup is
        // non-revertible — so the claim is spent and its remainder sits in the
        // account's public balance. Mark it so it's never re-offered; the
        // fresh deploy can pay from that balance.
        if (rec.bridgeId) await markBridgeConsumed(rec.bridgeId);
        await clearPendingDeploy(rec.network, rec.address);
        return false;
    }
    // Landed: finish the bookkeeping the dead session couldn't.
    if (rec.bridgeId) await markBridgeConsumed(rec.bridgeId);
    await clearPendingDeploy(rec.network, rec.address);
    return true;
}
