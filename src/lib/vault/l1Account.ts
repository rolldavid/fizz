/**
 * In-wallet L1 funding account.
 *
 * Fee juice can only enter L2 through the L1 bridge, and extension popups
 * never get an injected wallet (MetaMask only injects into web pages) — so the
 * wallet carries its OWN L1 account for the bridging step.
 *
 * Derivation is STANDARD BIP-44 (`m/44'/60'/0'/0/0`) from the user's 12-word
 * phrase — deliberately, so the same phrase restores this exact L1 account in
 * MetaMask or any Ethereum wallet. Funds parked here are never strandable.
 *
 * The private key exists in memory only while the vault is unlocked and is
 * zeroed on lock. It is derived from the FULL BIP-39 seed (which requires the
 * mnemonic), so derivation happens exactly once per unlock, at unlock time.
 */

import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

export const L1_DERIVATION_PATH = "m/44'/60'/0'/0/0";

export type L1KeyMaterial = {
    /** 32-byte secp256k1 private key. Zero it on lock. */
    privateKey: Uint8Array;
};

export function deriveL1Key(mnemonic: string): L1KeyMaterial {
    const fullSeed = mnemonicToSeedSync(mnemonic);
    const hd = HDKey.fromMasterSeed(fullSeed).derive(L1_DERIVATION_PATH);
    fullSeed.fill(0);
    if (!hd.privateKey || hd.privateKey.length !== 32) {
        throw new Error("L1 key derivation failed (no private key at path).");
    }
    const privateKey = new Uint8Array(hd.privateKey);
    // Wipe the HDKey's internal copy; ours is the only live one.
    hd.privateKey.fill(0);
    return { privateKey };
}

export function l1PrivateKeyToHex(key: L1KeyMaterial): `0x${string}` {
    return `0x${Array.from(key.privateKey, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
