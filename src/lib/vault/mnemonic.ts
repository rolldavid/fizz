import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

export function newMnemonic(): string {
    return generateMnemonic(wordlist, 128); // 12 words
}

export function isValidMnemonic(phrase: string): boolean {
    return validateMnemonic(phrase.trim().split(/\s+/).join(" "), wordlist);
}

/**
 * Derive a 32-byte seed from a mnemonic, ready to be turned into Aztec account
 * signing/derivation keys downstream. The mnemonic itself is the only true
 * secret — the derived seed is just a deterministic function of it.
 */
export function mnemonicToSeed(phrase: string): Uint8Array {
    const normalized = phrase.trim().split(/\s+/).join(" ");
    if (!validateMnemonic(normalized, wordlist)) {
        throw new Error("Invalid recovery phrase.");
    }
    const seed = mnemonicToSeedSync(normalized);
    // Take the first 32 bytes as the account-derivation secret.
    return seed.slice(0, 32);
}
