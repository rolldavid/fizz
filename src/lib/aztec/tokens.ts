import { KEYS, storage } from "../storage";
import type { AztecNetwork } from "./networks";

/**
 * A user-imported token. Address is the deployed Aztec contract address (hex).
 * Symbol/name/decimals are display-only metadata — we still query the contract
 * for `balance_of_*` and trust on-chain values for actual balance.
 *
 * `kind: "fee_juice"` is special — fee juice is a protocol-level asset, not a
 * standard token contract. Its "address" entry is purely a registry marker so
 * the UI can render it alongside other tokens.
 *
 * The list is scoped PER NETWORK **and PER ACCOUNT**:
 *   - per network: a token imported on sandbox must not be queried against the
 *     testnet node — the contract won't exist there, and the failed lookups
 *     would leak your token interests to the wrong operator.
 *   - per account: accounts are independent identities. A token account 1
 *     deployed or imported must not appear in account 2's list — each account
 *     curates its own (the strict rule: an account only ever shows its own
 *     state). Nothing here is on-chain; this is the local display list.
 */
export type TokenEntry = {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    kind: "token" | "fee_juice";
};

export const FEE_JUICE_ENTRY: TokenEntry = {
    address: "fee_juice",
    symbol: "JUICE",
    name: "Fee Juice",
    decimals: 18,
    kind: "fee_juice",
};

const DEFAULT_TOKENS: TokenEntry[] = [FEE_JUICE_ENTRY];

function networkKey(networkId: AztecNetwork["id"]): string {
    return `${KEYS.tokens}.${networkId}`;
}

function accountKey(networkId: AztecNetwork["id"], account: string): string {
    return `${KEYS.tokens}.${networkId}.${account}`;
}

/**
 * One-time migrations.
 *  - v0: the token list was global → attributed to sandbox (the default then).
 *  - v1: per-network only → SEED each account's list from the network list the
 *    first time that account reads tokens. A copy, not a move: every existing
 *    account keeps seeing the tokens it could see before the split, and the
 *    lists only diverge from then on. The network-level key is kept as the
 *    seed source for accounts derived later in old installs; harmless extra.
 */
async function migrateLegacyTokens(): Promise<void> {
    const legacy = await storage.get<TokenEntry[]>(KEYS.tokens);
    if (!legacy) return;
    const existing = await storage.get<TokenEntry[]>(networkKey("sandbox"));
    if (!existing) await storage.set(networkKey("sandbox"), legacy);
    await storage.remove(KEYS.tokens);
}

export async function loadTokens(
    networkId: AztecNetwork["id"],
    account: string,
): Promise<TokenEntry[]> {
    await migrateLegacyTokens();
    let stored = await storage.get<TokenEntry[]>(accountKey(networkId, account));
    if (!stored) {
        const networkLevel = await storage.get<TokenEntry[]>(networkKey(networkId));
        if (networkLevel) {
            stored = networkLevel;
            await storage.set(accountKey(networkId, account), networkLevel);
        }
    }
    if (!stored) return DEFAULT_TOKENS;
    if (!stored.find((t) => t.kind === "fee_juice")) return [FEE_JUICE_ENTRY, ...stored];
    return stored;
}

export async function saveTokens(
    networkId: AztecNetwork["id"],
    account: string,
    tokens: TokenEntry[],
): Promise<void> {
    await storage.set(accountKey(networkId, account), tokens);
}

export async function addToken(
    networkId: AztecNetwork["id"],
    account: string,
    entry: Omit<TokenEntry, "kind">,
): Promise<TokenEntry[]> {
    const tokens = await loadTokens(networkId, account);
    if (tokens.find((t) => t.address.toLowerCase() === entry.address.toLowerCase())) {
        throw new Error("Token already imported.");
    }
    const next = [...tokens, { ...entry, kind: "token" as const }];
    await saveTokens(networkId, account, next);
    return next;
}

export async function removeToken(
    networkId: AztecNetwork["id"],
    account: string,
    address: string,
): Promise<TokenEntry[]> {
    const tokens = await loadTokens(networkId, account);
    const next = tokens.filter(
        (t) => t.kind === "fee_juice" || t.address.toLowerCase() !== address.toLowerCase(),
    );
    await saveTokens(networkId, account, next);
    return next;
}
