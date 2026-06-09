/**
 * LIVE verification of the in-wallet funding-account bridge on TESTNET —
 * the exact path the Bridge screen runs. Opt-in (touches Sepolia, spends gas):
 *
 *   TESTNET_FUNDING=1 yarn vitest run --project e2e tests/e2e/funding-bridge.test.ts
 *
 * Prereqs: smoke state at /tmp/aztec-testnet-smoke.json and ~0.01 Sepolia ETH
 * on its derived funding address (m/44'/60'/0'/0/0).
 *
 * Proves: vault unlock derives the L1 key → funding status reads balances →
 * handler mint + portal deposit signed in-wallet → claim becomes consumable at
 * the PXE's anchor (ready to auto-pay the next tx).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";

import { getNetwork } from "../../src/lib/aztec/networks";
import { createBrowserWallet, deriveAccount, type AztecWallet } from "../../src/lib/aztec/wallet";
import {
    bridgeFromFundingAccount,
    getL1FundingAddress,
    getL1FundingStatus,
} from "../../src/lib/aztec/l1Funding";
import { listReadyClaims } from "../../src/lib/aztec/bridge";
import { vaultStore } from "../../src/lib/vault/store";
import { setMetaKeyProvider } from "../../src/lib/secureStorage";
import { waitFor } from "./helpers";
import { resetChromeStorage } from "../setup/chrome-stub";

const RUN = !!process.env.TESTNET_FUNDING;
const STATE_FILE = "/tmp/aztec-testnet-smoke.json";

const network = getNetwork("testnet");
let wallet: AztecWallet;
let recipient: Awaited<ReturnType<AztecWallet["createSchnorrAccount"]>>["address"];

describe.skipIf(!RUN)("in-wallet funding-account bridge — live testnet", () => {
    beforeAll(async () => {
        resetChromeStorage();
        if (!existsSync(STATE_FILE)) throw new Error(`No smoke state at ${STATE_FILE}.`);
        const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));

        // REAL vault path: creating the vault derives seed + L1 key exactly as
        // the popup does at unlock.
        await vaultStore.init();
        await vaultStore.createWithPassphrase(state.mnemonic, "funding-bridge-e2e-Pass-9!");
        setMetaKeyProvider(() => vaultStore.getMetaKey());

        wallet = await createBrowserWallet(network, { proverEnabled: true, ephemeral: true });
        const seed = vaultStore.getUnlocked()!.seed;
        const a0 = await deriveAccount(seed, 0);
        const mgr = await wallet.createSchnorrAccount(a0.secret, a0.salt, undefined, "main");
        recipient = mgr.address;
    }, 600_000);

    afterAll(async () => {
        await wallet?.stop();
        await vaultStore.destroy();
    });

    it("derives the funding address and reads live L1 balances", async () => {
        const status = await getL1FundingStatus(wallet, network);
        expect(status.address).toBe(getL1FundingAddress());
        expect(status.canMint).toBe(true); // testnet has a fee-asset handler
        expect(status.eth).toBeGreaterThan(0n); // seeded with gas
        console.log(
            `[funding] ${status.address} — ${status.ethFormatted} ETH, ` +
                `${status.feeAssetFormatted} ${status.feeAssetSymbol}`,
        );
    }, 120_000);

    it("mints + deposits via the in-wallet account; claim becomes consumable", async () => {
        const entry = await bridgeFromFundingAccount({
            wallet,
            network,
            recipient,
            mode: "mint",
        });
        expect(entry.claimSecret).toMatch(/^0x/);
        console.log(`[funding] deposit done — claim ${entry.claimAmount} pending`);

        await waitFor(
            async () => (await listReadyClaims(wallet, network.id, recipient)).length > 0,
            {
                label: "in-wallet bridged claim consumable at the PXE anchor",
                timeoutMs: 1_800_000,
                intervalMs: 30_000,
            },
        );
    }, 2_100_000);
});
