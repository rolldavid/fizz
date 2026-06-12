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
import { readFieldCompressedString } from "@aztec/aztec.js/utils";
import type { AztecWallet } from "./wallet";
import type { TokenEntry } from "./tokens";
import { FEE_JUICE_ENTRY } from "./tokens";
import { getTokenContract } from "./tokenContract";

/**
 * Token name/symbol come straight from an attacker-controlled contract. Strip
 * control, zero-width, and bidi-override characters (which can hide or reorder
 * the rendered identity — a fixed token row), collapse interior whitespace, and
 * hard-cap length. React escapes HTML so this is not XSS; it stops a scam token
 * from visually impersonating a trusted asset or distorting the wallet's UI.
 */
export function sanitizeTokenText(raw: string, maxLen: number): string {
    return raw
        .replace(/[\p{Cc}\p{Cf}]/gu, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLen)
        .trim(); // re-trim: the length cap can sever a word and leave a trailing space
}

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

export type TokenMetadata = { name: string; symbol: string; decimals: number };

/**
 * Read a token's name/symbol/decimals straight from its on-chain contract, so
 * importing a token needs only its address. Uses the standard Token's
 * `public_get_*` view functions (no transaction). Registering the instance with
 * the bundled Token artifact also validates that the address really is a
 * standard Aztec token — a non-token (or a differently-compiled token) fails
 * here loudly rather than getting saved with junk metadata.
 */
export async function fetchTokenMetadata(
    wallet: AztecWallet,
    address: AztecAddress,
    from: AztecAddress,
): Promise<TokenMetadata> {
    await ensureTokenRegistered(wallet, address);
    const Token = await getTokenContract();
    const contract = await Contract.at(address, Token.artifact, wallet as any);
    const [nameRaw, symbolRaw, decimalsRaw] = await Promise.all([
        contract.methods.public_get_name().simulate({ from }),
        contract.methods.public_get_symbol().simulate({ from }),
        contract.methods.public_get_decimals().simulate({ from }),
    ]);
    const name = sanitizeTokenText(readFieldCompressedString(unwrap(nameRaw)), 30);
    const symbol = sanitizeTokenText(readFieldCompressedString(unwrap(symbolRaw)), 11);
    const decimals = Number(unwrap<bigint | number>(decimalsRaw));
    if (!symbol) throw new Error("Contract returned an empty symbol — is this an Aztec token?");
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        throw new Error(`Contract returned invalid decimals (${decimals}).`);
    }
    // Reject impersonation of the reserved native fee-juice identity: an imported
    // token row shows only name+symbol (no contract address), so a scam token
    // reporting JUICE / "Fee Juice" would be visually indistinguishable from the
    // native gas asset. Refuse it at import rather than render a look-alike row.
    if (
        symbol.toLowerCase() === FEE_JUICE_ENTRY.symbol.toLowerCase() ||
        name.toLowerCase() === FEE_JUICE_ENTRY.name.toLowerCase()
    ) {
        throw new Error(
            "This token reports the native fee-juice identity (JUICE / Fee Juice). " +
                "Refusing to import an asset that impersonates gas.",
        );
    }
    return { name: name || symbol, symbol, decimals };
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

/**
 * Format a fee-juice amount (18 dp) for display as an AZTEC fee. Fees are tiny,
 * so this shows more fractional precision than a balance and never collapses a
 * nonzero fee to "0" (it floors to a "<0.000001" marker instead).
 */
export function formatFeeAztec(feeJuice: bigint): string {
    if (feeJuice <= 0n) return "0";
    const s = formatUnits(feeJuice, 18, 6);
    return s === "0" ? "<0.000001" : s;
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
