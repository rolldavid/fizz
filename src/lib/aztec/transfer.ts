/**
 * Token transfer helpers — private and public flavours, plus fee handling.
 *
 * Conventions follow @aztec/noir-contracts.js TokenContract (v4):
 *   - transfer(to, amount)                          → private → private
 *   - transfer_in_public(from, to, amount, nonce)   → public  → public
 *   - transfer_to_private(to, amount)               → public  → private (shield self)
 *   - transfer_to_public(from, to, amount, nonce)   → private → public (unshield)
 *
 * Fee strategy delegates to `./fee.ts`.
 */

import { Fr } from "@aztec/foundation/curves/bn254";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import type { AztecWallet } from "./wallet";
import type { AztecNetwork } from "./networks";
import { ensureTokenRegistered } from "./balances";
import { markFeeConsumed, resolveFeePaymentMethod } from "./fee";
import {
    assertPositiveAmount,
    assertSpendableRecipient,
    assertWithinU128,
    getTokenContract,
} from "./tokenContract";

export type TransferMode = "private" | "public";

type SendCtx = {
    wallet: AztecWallet;
    network: AztecNetwork;
    sender: AztecAddress;
};

/**
 * Pull the tx hash off a mined send result. The default `.send()` blocks until
 * mined and resolves to `{ receipt: TxReceipt }`, so the hash lives at
 * `sent.receipt.txHash` — NOT `sent.txHash` (reading the latter yielded
 * "[object Object]" in the UI). Throw rather than mask if it's absent.
 */
function txHashOf(sent: { receipt?: { txHash?: { toString(): string } } }): string {
    const hash = sent?.receipt?.txHash;
    if (!hash) throw new Error("Transaction was sent but returned no tx hash.");
    return hash.toString();
}

async function buildSendOptions(ctx: SendCtx) {
    const fee = await resolveFeePaymentMethod(ctx.wallet, ctx.network, ctx.sender);
    return {
        from: ctx.sender,
        fee: fee.method ? { paymentMethod: fee.method } : undefined,
        feeResolution: fee,
    };
}

export type TransferParams = SendCtx & {
    tokenAddress: AztecAddress;
    to: AztecAddress;
    amount: bigint;
    mode: TransferMode;
};

export async function transfer(params: TransferParams): Promise<{ txHash: string }> {
    assertPositiveAmount(params.amount);
    assertWithinU128(params.amount);
    assertSpendableRecipient(params.to);
    const Token = await getTokenContract();
    await ensureTokenRegistered(params.wallet, params.tokenAddress);
    const contract = await Contract.at(params.tokenAddress, Token.artifact, params.wallet as any);
    const { feeResolution, ...sendOpts } = await buildSendOptions(params);

    const method =
        params.mode === "private"
            ? contract.methods.transfer(params.to, params.amount)
            : contract.methods.transfer_in_public(params.sender, params.to, params.amount, Fr.ZERO);

    const sent = await method.send(sendOpts as any);
    await markFeeConsumed(feeResolution);
    return { txHash: txHashOf(sent) };
}

export type ShieldParams = SendCtx & {
    tokenAddress: AztecAddress;
    amount: bigint;
};

export async function shield(params: ShieldParams): Promise<{ txHash: string }> {
    assertPositiveAmount(params.amount);
    assertWithinU128(params.amount);
    const Token = await getTokenContract();
    await ensureTokenRegistered(params.wallet, params.tokenAddress);
    const contract = await Contract.at(params.tokenAddress, Token.artifact, params.wallet as any);
    const { feeResolution, ...sendOpts } = await buildSendOptions(params);
    const sent = await contract.methods
        .transfer_to_private(params.sender, params.amount)
        .send(sendOpts as any);
    await markFeeConsumed(feeResolution);
    return { txHash: txHashOf(sent) };
}

export async function unshield(params: ShieldParams): Promise<{ txHash: string }> {
    assertPositiveAmount(params.amount);
    assertWithinU128(params.amount);
    const Token = await getTokenContract();
    await ensureTokenRegistered(params.wallet, params.tokenAddress);
    const contract = await Contract.at(params.tokenAddress, Token.artifact, params.wallet as any);
    const { feeResolution, ...sendOpts } = await buildSendOptions(params);
    const sent = await contract.methods
        .transfer_to_public(params.sender, params.sender, params.amount, Fr.ZERO)
        .send(sendOpts as any);
    await markFeeConsumed(feeResolution);
    return { txHash: txHashOf(sent) };
}
