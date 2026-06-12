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

// ── Fee ESTIMATION (UI) ──────────────────────────────────────────────────────
//
// A tx fee (in fee juice, 18 decimals — surfaced to the user as "AZTEC") is
//   Σ_dimension  gasLimit[dimension] × maxFeePerGas[dimension]
// over the DA + L2 gas dimensions, for BOTH the main and teardown gas. Gas
// AMOUNTS come from a gas-estimating simulation; gas PRICES come from the
// chain's current min fees. We show an estimate (padded, "≈"), never an exact
// figure — base fees move between estimate and inclusion.

type GasAmount = { daGas: number | bigint; l2Gas: number | bigint };
type GasPrices = { feePerDaGas: bigint; feePerL2Gas: bigint };

function gasTimesFees(gas: GasAmount, fees: GasPrices): bigint {
    return BigInt(gas.daGas) * fees.feePerDaGas + BigInt(gas.l2Gas) * fees.feePerL2Gas;
}

/**
 * Stringify an error usefully. A DOMException (the PXE/IndexedDB layer throws
 * these) renders as the useless "[object DOMException]" when interpolated, which
 * hides the real cause — surface its name + message instead.
 */
function describeErr(err: unknown): string {
    if (err instanceof DOMException) return `${err.name}: ${err.message}`;
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    try {
        return String(err);
    } catch {
        return "unknown error";
    }
}

/**
 * Who actually pays this sender's next tx — WITHOUT taking the claim spend lock
 * (an estimate must never reserve a claim the real send will consume). Mirrors
 * resolveFeePaymentMethod's preference order: a ready bridge claim is spent
 * first (the user's own gas), then a sponsored FPC (covered — user pays
 * nothing), else the user's fee-juice balance (their own gas). Per product
 * decision, a bridged claim is presented as a NORMAL fee — it does come out of
 * the user's gas — so only the sponsored case is "covered".
 */
export async function peekFeeCovered(
    wallet: AztecWallet,
    network: AztecNetwork,
    sender: AztecAddress,
): Promise<boolean> {
    if ((await listReadyClaims(wallet, network.id, sender)).length > 0) return false;
    if (await isSponsoredFPCAvailable(wallet)) return true;
    return false;
}

/**
 * Estimated fee for an interaction, in fee-juice base units (18 dp), or null if
 * estimation isn't possible (e.g. an undeployed account that can't be simulated
 * yet). Best-effort: never throws into the caller — a missing estimate must not
 * block a send. skipFeeEnforcement so we don't need/lock a real fee source.
 */
export async function estimateInteractionFee(
    wallet: AztecWallet,
    sender: AztecAddress,
    interaction: { simulate(opts: unknown): Promise<unknown> },
): Promise<bigint | null> {
    let sim: { estimatedGas?: { gasLimits?: GasAmount; teardownGasLimits?: GasAmount } };
    try {
        sim = (await interaction.simulate({
            from: sender,
            skipFeeEnforcement: true,
            fee: { estimateGas: true },
        })) as typeof sim;
    } catch (err) {
        console.warn("Fee estimate unavailable (simulation failed):", describeErr(err));
        return null;
    }
    const est = sim?.estimatedGas;
    if (!est?.gasLimits || !est?.teardownGasLimits) return null;
    let fees: GasPrices;
    try {
        fees = (await (wallet as any).aztecNode.getCurrentMinFees()) as GasPrices;
    } catch (err) {
        console.warn("Fee estimate unavailable (no base fees):", describeErr(err));
        return null;
    }
    return gasTimesFees(est.gasLimits, fees) + gasTimesFees(est.teardownGasLimits, fees);
}

export type UiFeeEstimate =
    /** A sponsored FPC pays — the user spends nothing. */
    | { covered: true }
    /** The user pays from their own gas; feeJuice null = estimate unavailable. */
    | { covered: false; feeJuice: bigint | null };

/**
 * The single call a confirm/review screen makes: resolves whether the fee is
 * covered, and if not, the estimated amount the user will pay.
 */
export async function estimateUiFee(
    wallet: AztecWallet,
    network: AztecNetwork,
    sender: AztecAddress,
    interaction: { simulate(opts: unknown): Promise<unknown> },
): Promise<UiFeeEstimate> {
    // Best-effort at THIS boundary too: peekFeeCovered (listReadyClaims → PXE
    // sync, isSponsoredFPCAvailable) can throw on a PXE/SDK fault, and an
    // estimate must never throw into a confirm screen. A coverage-check failure
    // simply means "not known to be covered" — fall through to the amount
    // estimate, which itself returns null on failure.
    let covered = false;
    try {
        covered = await peekFeeCovered(wallet, network, sender);
    } catch (err) {
        console.warn("Fee estimate: coverage check unavailable:", describeErr(err));
    }
    if (covered) return { covered: true };
    return { covered: false, feeJuice: await estimateInteractionFee(wallet, sender, interaction) };
}

/**
 * Actual fee to DISPLAY post-send, given the resolved fee source. A sponsored
 * FPC pays the gas, so the receipt's transactionFee reflects what the SPONSOR
 * covered, not what the user paid — surfacing it would contradict the
 * pre-confirm "Covered" and read as a phantom charge. Return undefined in that
 * case (ActualFeeRow renders nothing); a claim/balance-paid tx shows the real
 * fee that came out of the user's gas.
 */
export function displayFeeForSource(
    label: ResolvedFee["label"],
    sent: { receipt?: { transactionFee?: bigint | { toString(): string } } },
): bigint | undefined {
    return label === "sponsored" ? undefined : feeJuiceFromReceipt(sent);
}

/** Actual fee paid, read from a mined send receipt (fee-juice base units). */
export function feeJuiceFromReceipt(sent: {
    receipt?: { transactionFee?: bigint | { toString(): string } };
}): bigint | undefined {
    const f = sent?.receipt?.transactionFee;
    if (f === undefined || f === null) return undefined;
    try {
        return typeof f === "bigint" ? f : BigInt(f.toString());
    } catch {
        return undefined;
    }
}

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
