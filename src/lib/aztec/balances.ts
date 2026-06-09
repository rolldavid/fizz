/**
 * Balance queries for ERC20-ish Aztec tokens and for native fee juice.
 *
 * Conventions follow @aztec/noir-contracts.js Token contract:
 *   - balance_of_public(owner) → public Field balance
 *   - balance_of_private(owner) → private Field balance (utility / unconstrained)
 *
 * Fee juice is exposed by the protocol's FeeJuice contract at a well-known
 * protocol address; we read its public balance the same way as any other token.
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import type { AztecWallet } from "./wallet";
import type { TokenEntry } from "./tokens";
import { getTokenContract } from "./tokenContract";

export type TokenBalance = {
    public: bigint;
    private: bigint;
};

const ZERO: TokenBalance = { public: 0n, private: 0n };

function unwrap<T>(simulationResult: any): T {
    // v4 simulate returns { result, ... }. Older shapes returned the raw value.
    if (simulationResult && typeof simulationResult === "object" && "result" in simulationResult) {
        return simulationResult.result as T;
    }
    return simulationResult as T;
}

const registeredByWallet = new WeakMap<AztecWallet, Set<string>>();

/**
 * Register an imported token's on-chain instance in the PXE before use.
 *
 * `Contract.at()` is a pure constructor — it does NOT touch the PXE. Every
 * subsequent call runs `ensureContractSynced`, which throws "No contract
 * instance found for address …" if the instance was never registered. Deployed
 * tokens and protocol contracts (fee juice) self-register, but a token the user
 * imports by address must be registered here or all of its balance reads and
 * transfers throw. Idempotent and cached per wallet (the PXE no-ops a re-register,
 * and a new wallet after a network switch starts with a fresh cache).
 */
export async function ensureTokenRegistered(
    wallet: AztecWallet,
    address: AztecAddress,
): Promise<void> {
    let set = registeredByWallet.get(wallet);
    if (!set) {
        set = new Set<string>();
        registeredByWallet.set(wallet, set);
    }
    const key = address.toString();
    if (set.has(key)) return;

    const w = wallet as any;
    const instance = await w.aztecNode.getContract(address);
    if (!instance) {
        throw new Error(`Token ${key} is not deployed on this network.`);
    }
    const Token = await getTokenContract();
    await w.registerContract(instance, Token.artifact);
    set.add(key);
}

export async function getTokenBalance(
    wallet: AztecWallet,
    owner: AztecAddress,
    token: TokenEntry,
): Promise<TokenBalance> {
    if (token.kind === "fee_juice") {
        const contract = FeeJuiceContract.at(wallet as any);
        const pub = await contract.methods.balance_of_public(owner).simulate({ from: owner });
        return { public: BigInt(unwrap<bigint>(pub)), private: 0n };
    }

    const Token = await getTokenContract();
    const address = AztecAddress.fromString(token.address);
    await ensureTokenRegistered(wallet, address);
    const contract = await Contract.at(address, Token.artifact, wallet as any);
    const [pub, priv] = await Promise.all([
        contract.methods.balance_of_public(owner).simulate({ from: owner }),
        contract.methods.balance_of_private(owner).simulate({ from: owner }),
    ]);
    return {
        public: BigInt(unwrap<bigint>(pub)),
        private: BigInt(unwrap<bigint>(priv)),
    };
}

export { ZERO as ZERO_BALANCE };

export function formatUnits(value: bigint, decimals: number, maxFractionDigits = 4): string {
    if (value === 0n) return "0";
    const sign = value < 0n ? "-" : "";
    const abs = value < 0n ? -value : value;
    const base = 10n ** BigInt(decimals);
    const whole = abs / base;
    const frac = abs % base;
    if (frac === 0n) return `${sign}${whole}`;
    const fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFractionDigits);
    const trimmed = fracStr.replace(/0+$/, "");
    return trimmed ? `${sign}${whole}.${trimmed}` : `${sign}${whole}`;
}

export function parseUnits(value: string, decimals: number): bigint {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        throw new Error(`Invalid decimals: ${decimals}.`);
    }
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Amount is required.");
    // Must be plain decimal digits with at most one dot, and contain at least
    // one digit — "." alone previously parsed to 0, masking typos.
    if (!/^\d*\.?\d*$/.test(trimmed) || !/\d/.test(trimmed)) {
        throw new Error("Invalid amount.");
    }
    const [whole, frac = ""] = trimmed.split(".");
    if (frac.length > decimals) throw new Error(`Too many decimals (max ${decimals}).`);
    const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
    return BigInt((whole || "0") + padded);
}
