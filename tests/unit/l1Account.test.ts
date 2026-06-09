import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
    L1_DERIVATION_PATH,
    deriveL1Key,
    l1PrivateKeyToHex,
} from "../../src/lib/vault/l1Account";

/**
 * PINNED VECTOR — the in-wallet L1 funding account must derive at the STANDARD
 * Ethereum path so the user's 12 words restore it in MetaMask/any wallet.
 * Proof of standardness: the canonical dev mnemonic must yield anvil/hardhat
 * account #0. If this test fails, funds sent to funding addresses become
 * unreachable from other wallets — never update the expectation; fix the code.
 */
const MNEMONIC = "test test test test test test test test test test test junk";
const ANVIL_ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("L1 funding account derivation", () => {
    it("uses the standard BIP-44 Ethereum path", () => {
        expect(L1_DERIVATION_PATH).toBe("m/44'/60'/0'/0/0");
    });

    it("canonical dev mnemonic derives anvil account #0 (MetaMask-compatible)", () => {
        const key = deriveL1Key(MNEMONIC);
        const account = privateKeyToAccount(l1PrivateKeyToHex(key));
        expect(account.address).toBe(ANVIL_ACCOUNT_0);
        key.privateKey.fill(0);
    });

    it("is deterministic and 32 bytes", () => {
        const a = deriveL1Key(MNEMONIC);
        const b = deriveL1Key(MNEMONIC);
        expect(a.privateKey.length).toBe(32);
        expect(l1PrivateKeyToHex(a)).toBe(l1PrivateKeyToHex(b));
        a.privateKey.fill(0);
        b.privateKey.fill(0);
    });

    it("different mnemonics give different keys", () => {
        const a = deriveL1Key(MNEMONIC);
        const b = deriveL1Key(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        );
        expect(l1PrivateKeyToHex(a)).not.toBe(l1PrivateKeyToHex(b));
        a.privateKey.fill(0);
        b.privateKey.fill(0);
    });
});
