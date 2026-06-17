import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Loader for the (optional) FUNDED test accounts. Two shapes are supported:
 *
 *  1. SAME WALLET, two accounts (the common case): provide ONE wallet `a` with a
 *     funded token. The cross-account test imports that seed and transfers
 *     between account index 0 and 1 (same seed, different addresses). No `b`.
 *
 *  2. TWO SEPARATE WALLETS: provide `a` AND `b` with different mnemonics. The
 *     cross-WALLET test stands up two extension instances and transfers A → B.
 *
 * No real password/passkey is ever needed — the test sets its own throwaway
 * unlock password when it imports the phrase. The mnemonic controls the funds.
 *
 * These are SECRETS — never committed, never logged:
 *   - file:  tests/playwright/.accounts.local.json   (gitignored)
 *   - or env: PW_ACCOUNT_A [PW_ACCOUNT_B] + PW_NETWORK_ID + PW_TOKEN_ADDRESS …
 *
 * Absent → funded specs SKIP. Present-but-malformed → THROW (loud, not silent).
 */
export type FundedAccount = {
    /** 12-word BIP39 recovery phrase. */
    mnemonic: string;
    /** Unlock password set on import (defaults to the suite test passphrase). */
    password?: string;
    /** HD account index to use for this party (same-wallet mode). */
    accountIndex?: number;
};

export type FundedConfig = {
    /** Network the accounts are funded on: "alpha" (mainnet) | "testnet" | … */
    network: string;
    /** A sendable token (held by one of the accounts). Required for transfers. */
    token?: { address: string; symbol?: string };
    /** Amount to move in a transfer (token units). Default "1". */
    amount?: string;
    /** Primary wallet (sender). Always required when funded config is present. */
    a: FundedAccount;
    /** Optional second, SEPARATE wallet — only for the two-wallet cross test. */
    b?: FundedAccount;
    /** Specific account ADDRESSES to test in same-seed mode — each is resolved to
     *  its HD account index. The two entries are the two parties; the sender is
     *  auto-detected by which one holds the token. Falls back to indices 0 and 1. */
    accounts?: string[];
};

const FILE = join(process.cwd(), "tests/playwright/.accounts.local.json");

/** A genuinely filled-in phrase: ≥12 words and not a REPLACE/template placeholder.
 *  Lets an unedited template (or unset env) be treated as "not configured" (skip)
 *  rather than a malformed config (throw). */
const looksLikePhrase = (m: string | undefined): boolean =>
    !!m && m.trim().split(/\s+/).filter(Boolean).length >= 12 && !/REPLACE/i.test(m);

/** Drop placeholder token addresses so a template doesn't activate transfers. */
const realToken = (t: FundedConfig["token"]): FundedConfig["token"] =>
    t?.address && !/REPLACE/i.test(t.address) ? t : undefined;

function fromEnv(): FundedConfig | null {
    if (!looksLikePhrase(process.env.PW_ACCOUNT_A)) return null;
    const network = process.env.PW_NETWORK_ID;
    if (!network) {
        throw new Error("PW_ACCOUNT_A set but PW_NETWORK_ID missing — set the network explicitly.");
    }
    const tokenAddress = process.env.PW_TOKEN_ADDRESS;
    return {
        network,
        token: realToken(
            tokenAddress ? { address: tokenAddress, symbol: process.env.PW_TOKEN_SYMBOL } : undefined,
        ),
        amount: process.env.PW_TRANSFER_AMOUNT,
        a: { mnemonic: process.env.PW_ACCOUNT_A!, password: process.env.PW_ACCOUNT_A_PASSWORD },
        b: looksLikePhrase(process.env.PW_ACCOUNT_B)
            ? { mnemonic: process.env.PW_ACCOUNT_B!, password: process.env.PW_ACCOUNT_B_PASSWORD }
            : undefined,
        accounts: process.env.PW_ACCOUNT_ADDRESSES?.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    };
}

function fromFile(): FundedConfig | null {
    if (!existsSync(FILE)) return null;
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as Partial<FundedConfig>;
    // An unedited template (placeholder phrase) is "not configured" → skip.
    if (!looksLikePhrase(raw.a?.mnemonic)) return null;
    if (!raw.network) throw new Error(`${FILE} has a wallet but no "network".`);
    return {
        network: raw.network,
        token: realToken(raw.token),
        amount: raw.amount,
        a: raw.a as FundedAccount,
        b: looksLikePhrase(raw.b?.mnemonic) ? (raw.b as FundedAccount) : undefined,
        accounts: Array.isArray(raw.accounts) ? raw.accounts : undefined,
    };
}

let cached: FundedConfig | null | undefined;

/** The funded config from env (preferred) or the gitignored file, else null. */
export function loadFundedConfig(): FundedConfig | null {
    if (cached !== undefined) return cached;
    cached = fromEnv() ?? fromFile();
    return cached;
}

/** True when funded accounts are configured (file or env). */
export const hasFunded = (): boolean => loadFundedConfig() !== null;
