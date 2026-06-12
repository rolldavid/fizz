/**
 * Fee payment method resolution. Picks the best option for this network/account:
 *
 *   1. A pending fee-juice bridge claim → FeeJuicePaymentMethodWithClaim
 *      (consumes the L1→L2 message in the same tx that pays the fee).
 *   2. A sponsored FPC if the network has one (sandbox & devnet do).
 *   3. Nothing — caller will default to fee juice from existing balance.
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/foundation/curves/bn254";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import {
    FeeJuicePaymentMethodWithClaim,
    SponsoredFeePaymentMethod,
} from "@aztec/aztec.js/fee";
import type { FeePaymentMethod } from "@aztec/aztec.js/fee";
import {
    SponsoredFPCContract,
    SponsoredFPCContractArtifact,
} from "@aztec/noir-contracts.js/SponsoredFPC";
import type { AztecNetwork } from "./networks";
import type { AztecWallet } from "./wallet";
import {
    listPendingBridges,
    listReadyClaims,
    lockClaimForSpend,
    markBridgeConsumed,
    releaseClaimSpendLock,
} from "./bridge";
import { getTokenBalance } from "./balances";
import { FEE_JUICE_ENTRY } from "./tokens";

let sponsoredAddressPromise: Promise<AztecAddress> | null = null;
export async function getSponsoredFPCAddress(): Promise<AztecAddress> {
    if (!sponsoredAddressPromise) {
        sponsoredAddressPromise = (async () => {
            const instance = await getContractInstanceFromInstantiationParams(
                SponsoredFPCContractArtifact,
                { salt: new Fr(SPONSORED_FPC_SALT) },
            );
            return instance.address;
        })();
    }
    return sponsoredAddressPromise;
}

/**
 * Ensure the PXE knows about the sponsored FPC artifact so it can build the
 * payment proof. Registering the same contract twice is a no-op.
 */
async function ensureSponsoredFPCRegistered(wallet: AztecWallet): Promise<AztecAddress> {
    const address = await getSponsoredFPCAddress();
    const instance = await getContractInstanceFromInstantiationParams(
        SponsoredFPCContractArtifact,
        { salt: new Fr(SPONSORED_FPC_SALT) },
    );
    try {
        await (wallet as any).registerContract(instance, SponsoredFPCContractArtifact);
    } catch (err) {
        // Only the expected "already registered" case is a no-op. A genuine
        // failure (corrupt/incompatible artifact, PXE store fault, SDK shape
        // change) must NOT be swallowed — otherwise we hand back a payment
        // method the PXE can't prove against and the tx fails deeper in the SDK
        // with a far less actionable error (and the no-swallow rule is broken).
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already\s+(registered|exists)/i.test(msg)) {
            console.error("SponsoredFPC registration failed:", err);
            throw err;
        }
    }
    void SponsoredFPCContract; // keep typings reachable for future direct calls.
    return address;
}

/**
 * Live on-chain probe: is the canonical sponsored FPC actually deployed on the
 * network this wallet is connected to? Cached per wallet instance. This beats
 * trusting a static per-network flag — networks redeploy, and custom nodes are
 * unknowable in advance. `network.hasSponsoredFPC` remains a UI hint only.
 */
const sponsoredAvailabilityByWallet = new WeakMap<object, Promise<boolean>>();
export function isSponsoredFPCAvailable(wallet: AztecWallet): Promise<boolean> {
    let cached = sponsoredAvailabilityByWallet.get(wallet as object);
    if (!cached) {
        cached = (async () => {
            const address = await getSponsoredFPCAddress();
            const instance = await (wallet as any).aztecNode.getContract(address);
            return instance != null;
        })();
        sponsoredAvailabilityByWallet.set(wallet as object, cached);
    }
    return cached;
}

/**
 * Sponsored-FPC payment method, or null when this network has none deployed
 * (a valid state — mainnet). Probes the chain (cached per wallet) and registers
 * the FPC artifact in the PXE on first use.
 */
export async function resolveSponsoredFeePaymentMethod(
    wallet: AztecWallet,
): Promise<SponsoredFeePaymentMethod | null> {
    if (!(await isSponsoredFPCAvailable(wallet))) return null;
    const address = await ensureSponsoredFPCRegistered(wallet);
    return new SponsoredFeePaymentMethod(address);
}

export type ResolvedFee = {
    method: FeePaymentMethod | undefined;
    label: "claim" | "sponsored" | "fee_juice";
    /** Bridge id that was attached to this tx (if any), so caller can mark it consumed on success. */
    consumesBridgeId?: string;
};

export async function resolveFeePaymentMethod(
    wallet: AztecWallet,
    network: AztecNetwork,
    sender: AztecAddress,
): Promise<ResolvedFee> {
    // Only claims bridged to THIS sender and already synced onto L2 — attaching
    // an unready or wrong-recipient claim would make the tx fail.
    //
    // Take the in-memory spend lock on the claim we pick (skipping any a
    // concurrent in-flight tx already holds). The L1→L2 message nullifies on
    // first consumption, so two txs attaching the SAME claim both fail; the lock
    // closes the common same-context double-attach window (double-click, or a
    // send racing an account-deploy/sweep) that the on-chain witness check —
    // which only excludes a claim AFTER its nullifier is mined — cannot. The
    // caller releases it via markFeeConsumed (success) or releaseFee (failure).
    const claims = await listReadyClaims(wallet, network.id, sender);
    for (const claim of claims) {
        if (!lockClaimForSpend(claim.id)) continue;
        let method: FeePaymentMethod;
        try {
            method = new FeeJuicePaymentMethodWithClaim(sender, {
                claimAmount: BigInt(claim.claimAmount),
                claimSecret: Fr.fromHexString(claim.claimSecret),
                // listReadyClaims only returns claimable entries (field guaranteed).
                messageLeafIndex: BigInt(claim.messageLeafIndex!),
            });
        } catch (err) {
            // A malformed claim slipped through (shouldn't — listReadyClaims gates
            // on-chain): release the lock we just took so it isn't stranded, and
            // try the next ready claim rather than wedging fee resolution.
            releaseClaimSpendLock(claim.id);
            console.error(`Skipping unbuildable claim ${claim.id}:`, err);
            continue;
        }
        return { method, label: "claim", consumesBridgeId: claim.id };
    }

    // Probe the chain (cached per wallet) rather than trusting the static
    // network flag — networks redeploy and custom nodes are unknowable.
    const sponsored = await resolveSponsoredFeePaymentMethod(wallet);
    if (sponsored) {
        return { method: sponsored, label: "sponsored" };
    }

    return { method: undefined, label: "fee_juice" };
}

/** Tx succeeded: mark the attached claim consumed and release its spend lock. */
export async function markFeeConsumed(fee: ResolvedFee) {
    if (fee.consumesBridgeId) {
        await markBridgeConsumed(fee.consumesBridgeId);
        releaseClaimSpendLock(fee.consumesBridgeId);
    }
}

/**
 * Tx failed/aborted before consuming the claim: release the spend lock WITHOUT
 * marking it consumed, so the claim returns to the pool for the next attempt.
 * Must run in a finally/catch on every fee-paying send path or a failed tx
 * would strand the claim (locked, unspent) for the rest of the session.
 */
export function releaseFee(fee: ResolvedFee) {
    if (fee.consumesBridgeId) releaseClaimSpendLock(fee.consumesBridgeId);
}

/**
 * Can this account pay for a transaction RIGHT NOW — and if not, why?
 *
 *   ready     — a fee source exists: sponsored FPC, own fee-juice balance, or
 *               a bridge claim that's consumable on L2.
 *   incoming  — no source yet, but a bridge to this account is in flight
 *               (deposit confirming, message syncing, or the background
 *               landing tx pending). The right answer is WAIT, not retry.
 *   none      — no gas and nothing on the way: send the user to get gas.
 *
 * Send-type screens gate on this BEFORE building a transaction: attempting a
 * send with no fee source dies deep in the SDK with an unhelpful schema error
 * ("Expected string, received object") instead of anything actionable.
 */
export type FeeReadiness = { kind: "ready" } | { kind: "incoming" } | { kind: "none" };

export async function assessFeeReadiness(
    wallet: AztecWallet,
    network: AztecNetwork,
    sender: AztecAddress,
): Promise<FeeReadiness> {
    if (await isSponsoredFPCAvailable(wallet)) return { kind: "ready" };
    const balance = await getTokenBalance(wallet, sender, FEE_JUICE_ENTRY);
    if (balance.public > 0n) return { kind: "ready" };
    if ((await listReadyClaims(wallet, network.id, sender)).length > 0) return { kind: "ready" };
    // listPendingBridges already excludes consumed/dismissed entries; "failed"
    // deposits are dead, not incoming.
    const inFlight = (await listPendingBridges(network.id)).filter(
        (b) => b.recipient === sender.toString() && b.status !== "failed",
    );
    if (inFlight.length > 0) return { kind: "incoming" };
    return { kind: "none" };
}
