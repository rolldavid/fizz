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
import { listReadyClaims, markBridgeConsumed } from "./bridge";

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
    } catch {
        // Already registered. Continue.
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
    const claims = await listReadyClaims(wallet, network.id, sender);
    if (claims.length > 0) {
        const claim = claims[0];
        const method = new FeeJuicePaymentMethodWithClaim(sender, {
            claimAmount: BigInt(claim.claimAmount),
            claimSecret: Fr.fromHexString(claim.claimSecret),
            // listReadyClaims only returns claimable entries (field guaranteed).
            messageLeafIndex: BigInt(claim.messageLeafIndex!),
        });
        return { method, label: "claim", consumesBridgeId: claim.id };
    }

    // Probe the chain (cached per wallet) rather than trusting the static
    // network flag — networks redeploy and custom nodes are unknowable.
    if (await isSponsoredFPCAvailable(wallet)) {
        const address = await ensureSponsoredFPCRegistered(wallet);
        return { method: new SponsoredFeePaymentMethod(address), label: "sponsored" };
    }

    return { method: undefined, label: "fee_juice" };
}

export async function markFeeConsumed(fee: ResolvedFee) {
    if (fee.consumesBridgeId) await markBridgeConsumed(fee.consumesBridgeId);
}
