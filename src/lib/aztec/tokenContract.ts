/**
 * Shared access to the @aztec/noir-contracts.js Token artifact.
 *
 * The artifact is large, so it is dynamically imported exactly once and cached.
 * Every module that talks to a token (balances, transfer, deploy, mint) goes
 * through this so the bundle contains a single lazy chunk for it.
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";

export type TokenContractClass = any;

let tokenContractPromise: Promise<TokenContractClass> | null = null;

export async function getTokenContract(): Promise<TokenContractClass> {
    if (!tokenContractPromise) {
        tokenContractPromise = import("@aztec/noir-contracts.js/Token").then((m: any) => {
            const Token = m.TokenContract ?? m.default;
            if (!Token) throw new Error("TokenContract artifact unavailable.");
            return Token;
        });
    }
    return tokenContractPromise;
}

/**
 * Transaction-level amount guard. parseUnits accepts "0" (a valid number), but
 * no token operation in this wallet ever wants a zero or negative amount — a
 * zero transfer burns a real fee for nothing and a negative amount is a bug.
 */
export function assertPositiveAmount(amount: bigint): void {
    if (amount <= 0n) {
        throw new Error("Amount must be greater than zero.");
    }
}

/** Max value of the Token contract's u128 amounts. Anything above reverts in-circuit. */
export const MAX_U128 = (1n << 128n) - 1n;

export function assertWithinU128(amount: bigint): void {
    if (amount > MAX_U128) {
        throw new Error("Amount exceeds the maximum the token supports (u128).");
    }
}

/**
 * Reject the zero address as a recipient. 0x0 is a valid BN254 field element, so
 * AztecAddress.fromString parses it without error, but a private note or public
 * balance sent there is unspendable — a permanent, silent loss. No wallet flow
 * ever legitimately targets it, so guard every fund-moving path defensively
 * (not just the UI, which a draft/contact could bypass).
 */
export function assertSpendableRecipient(to: AztecAddress): void {
    if (to.equals(AztecAddress.ZERO)) {
        throw new Error("Recipient is the zero address — sending there would burn the funds.");
    }
}
