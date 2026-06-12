/**
 * Token minting — for accounts that hold the minter role on a token.
 *
 * Conventions follow @aztec/noir-contracts.js TokenContract (v4):
 *   - mint_to_public(to, amount)   → creates public balance (public fn)
 *   - mint_to_private(to, amount)  → creates a private note for `to` (private fn)
 *   - is_minter(addr) / get_admin() are utility reads used to gate the UI.
 *
 * The deployer of a token is its admin and initial minter (unless revoked at
 * deploy time via `set_minter(deployer, false)`).
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import type { AztecWallet } from "./wallet";
import type { AztecNetwork } from "./networks";
import { ensureTokenRegistered } from "./balances";
import {
    estimateUiFee,
    feeJuiceFromReceipt,
    markFeeConsumed,
    releaseFee,
    resolveFeePaymentMethod,
    type UiFeeEstimate,
} from "./fee";
import {
    assertPositiveAmount,
    assertSpendableRecipient,
    assertWithinU128,
    getTokenContract,
} from "./tokenContract";

export type MintMode = "private" | "public";

export type MintParams = {
    wallet: AztecWallet;
    network: AztecNetwork;
    /** The account sending the mint tx — must hold the minter role. */
    minter: AztecAddress;
    tokenAddress: AztecAddress;
    /** Recipient of the newly minted tokens. */
    to: AztecAddress;
    /** Base units. */
    amount: bigint;
    mode: MintMode;
};

function txHashOf(sent: { receipt?: { txHash?: { toString(): string } } }): string {
    const hash = sent?.receipt?.txHash;
    if (!hash) throw new Error("Mint was sent but returned no tx hash.");
    return hash.toString();
}

async function mintMethod(params: MintParams) {
    const Token = await getTokenContract();
    await ensureTokenRegistered(params.wallet, params.tokenAddress);
    const contract = await Contract.at(params.tokenAddress, Token.artifact, params.wallet as any);
    return params.mode === "private"
        ? contract.methods.mint_to_private(params.to, params.amount)
        : contract.methods.mint_to_public(params.to, params.amount);
}

export async function mintToken(params: MintParams): Promise<{ txHash: string; feeJuice?: bigint }> {
    assertPositiveAmount(params.amount);
    assertWithinU128(params.amount);
    assertSpendableRecipient(params.to);
    const method = await mintMethod(params);
    const fee = await resolveFeePaymentMethod(params.wallet, params.network, params.minter);

    let sent;
    try {
        sent = await method.send({
            from: params.minter,
            ...(fee.method ? { fee: { paymentMethod: fee.method } } : {}),
        } as any);
    } catch (err) {
        releaseFee(fee); // claim un-consumed — return it to the pool
        throw err;
    }
    await markFeeConsumed(fee);
    return { txHash: txHashOf(sent), feeJuice: feeJuiceFromReceipt(sent) };
}

/** Pre-confirm fee estimate for a mint. */
export async function estimateMintFee(params: MintParams): Promise<UiFeeEstimate> {
    return estimateUiFee(params.wallet, params.network, params.minter, (await mintMethod(params)) as any);
}

export type MintAuthority = {
    isMinter: boolean;
    isAdmin: boolean;
    admin: string;
};

/**
 * Read whether `viewer` can mint on this token (and whether they're the admin,
 * which additionally allows granting/revoking minters). Both reads are utility
 * (free, local simulation against synced public state).
 */
export async function getMintAuthority(
    wallet: AztecWallet,
    tokenAddress: AztecAddress,
    viewer: AztecAddress,
): Promise<MintAuthority> {
    const Token = await getTokenContract();
    await ensureTokenRegistered(wallet, tokenAddress);
    const contract = await Contract.at(tokenAddress, Token.artifact, wallet as any);

    const unwrap = (v: any) => (v && typeof v === "object" && "result" in v ? v.result : v);
    const [isMinterRaw, adminRaw] = await Promise.all([
        contract.methods.is_minter(viewer).simulate({ from: viewer }),
        contract.methods.get_admin().simulate({ from: viewer }),
    ]);
    const admin = decodeAddress(unwrap(adminRaw)).toString();
    return {
        isMinter: Boolean(unwrap(isMinterRaw)),
        isAdmin: admin === viewer.toString(),
        admin,
    };
}

/**
 * Normalize the simulate() return for an address-typed value. Depending on the
 * ABI decoder it arrives as an AztecAddress, an Fr-like object with toString()
 * yielding 0x-hex, or a raw bigint field value. Anything else is a bug.
 */
function decodeAddress(value: unknown): AztecAddress {
    if (value instanceof AztecAddress) return value;
    if (typeof value === "bigint") {
        return AztecAddress.fromBigInt(value);
    }
    if (value && typeof (value as any).toString === "function") {
        const s = (value as any).toString();
        if (typeof s === "string" && s.startsWith("0x")) return AztecAddress.fromString(s);
    }
    throw new Error(`Cannot decode address from simulate() result: ${String(value)}`);
}
