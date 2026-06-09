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
 * The list is scoped PER NETWORK: a token imported on sandbox must not be
 * queried against the testnet node — the contract won't exist there, and the
 * failed lookups would leak your token interests to the wrong operator.
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

function key(networkId: AztecNetwork["id"]): string {
    return `${KEYS.tokens}.${networkId}`;
}

/**
 * One-time migration: the token list used to be global. Attribute any legacy
 * list to the default network (sandbox) where it was almost certainly created,
 * then delete the legacy key.
 */
async function migrateLegacyTokens(): Promise<void> {
    const legacy = await storage.get<TokenEntry[]>(KEYS.tokens);
    if (!legacy) return;
    const existing = await storage.get<TokenEntry[]>(key("sandbox"));
    if (!existing) await storage.set(key("sandbox"), legacy);
    await storage.remove(KEYS.tokens);
}

export async function loadTokens(networkId: AztecNetwork["id"]): Promise<TokenEntry[]> {
    await migrateLegacyTokens();
    const stored = await storage.get<TokenEntry[]>(key(networkId));
    if (!stored) return DEFAULT_TOKENS;
    if (!stored.find((t) => t.kind === "fee_juice")) return [FEE_JUICE_ENTRY, ...stored];
    return stored;
}

export async function saveTokens(
    networkId: AztecNetwork["id"],
    tokens: TokenEntry[],
): Promise<void> {
    await storage.set(key(networkId), tokens);
}

export async function addToken(
    networkId: AztecNetwork["id"],
    entry: Omit<TokenEntry, "kind">,
): Promise<TokenEntry[]> {
    const tokens = await loadTokens(networkId);
    if (tokens.find((t) => t.address.toLowerCase() === entry.address.toLowerCase())) {
        throw new Error("Token already imported.");
    }
    const next = [...tokens, { ...entry, kind: "token" as const }];
    await saveTokens(networkId, next);
    return next;
}

export async function removeToken(
    networkId: AztecNetwork["id"],
    address: string,
): Promise<TokenEntry[]> {
    const tokens = await loadTokens(networkId);
    const next = tokens.filter(
        (t) => t.kind === "fee_juice" || t.address.toLowerCase() !== address.toLowerCase(),
    );
    await saveTokens(networkId, next);
    return next;
}
