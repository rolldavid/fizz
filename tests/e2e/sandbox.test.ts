/**
 * GROUND-TRUTH E2E: the wallet's own lib code against a live local Aztec network.
 *
 * Run `aztec start --local-network` first. This suite proves, in order:
 *   1. wallet boot (the real createBrowserWallet path, ephemeral stores)
 *   2. token deployment with initial public supply  (deploy.ts)
 *   3. balance reads, public + private              (balances.ts)
 *   4. minting to public and private                (mint.ts)
 *   5. mint authority reads                         (mint.ts)
 *   6. shield / unshield                            (transfer.ts)
 *   7. private + public transfers BETWEEN two independent wallets,
 *      including tag-based note discovery           (transfer.ts + contacts.ts)
 *   8. error edges: zero amount, insufficient funds, unknown token
 *   9. the full new-user journey: fresh mnemonic account receives a private
 *      payment while UNDEPLOYED, bridges L1 fee juice, deploys its account
 *      contract paying with the claim, then spends   (wallet.ts + bridge.ts + fee.ts)
 *
 * Tests share state and run strictly in order (configured in vitest.workspace.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { ContractInitializationStatus } from "@aztec/aztec.js/wallet";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";

import { getNetwork } from "../../src/lib/aztec/networks";
import {
    createBrowserWallet,
    deployAccountContract,
    deriveAccount,
    type AztecWallet,
} from "../../src/lib/aztec/wallet";
import { deployToken } from "../../src/lib/aztec/deploy";
import { getMintAuthority, mintToken } from "../../src/lib/aztec/mint";
import { shield, transfer, unshield } from "../../src/lib/aztec/transfer";
import { ensureTokenRegistered, getTokenBalance } from "../../src/lib/aztec/balances";
import { addContact, syncContactsToPxe } from "../../src/lib/aztec/contacts";
import { SANDBOX_MINT_AMOUNT, bridgeFeeJuice, listReadyClaims } from "../../src/lib/aztec/bridge";
import { markFeeConsumed, resolveFeePaymentMethod } from "../../src/lib/aztec/fee";
import { mnemonicToSeed } from "../../src/lib/vault/mnemonic";
import { FEE_JUICE_ENTRY, type TokenEntry } from "../../src/lib/aztec/tokens";
import { anvilProvider, assertSandboxUp, waitFor } from "./helpers";
import { resetChromeStorage } from "../setup/chrome-stub";

const network = getNetwork("sandbox");
const TEST_OVERRIDES = { proverEnabled: false, ephemeral: true } as const;

// Shared lifecycle state — built up test by test.
let walletA: AztecWallet; // hosts alice (funded sandbox test account 0)
let walletB: AztecWallet; // hosts bob   (funded sandbox test account 1) — independent PXE
let walletC: AztecWallet; // hosts the fresh mnemonic-derived account (new-user journey)
let alice: AztecAddress;
let bob: AztecAddress;
let fresh: AztecAddress;
let freshManager: Awaited<ReturnType<AztecWallet["createSchnorrAccount"]>>;
let token: TokenEntry;
let tokenAddress: AztecAddress;

const DECIMALS = 6;
const u = (n: number | bigint) => BigInt(n) * 10n ** BigInt(DECIMALS);

async function balances(wallet: AztecWallet, owner: AztecAddress) {
    return getTokenBalance(wallet, owner, token);
}

/**
 * Register `addr` as a known sender in `wallet`'s PXE via the contacts flow.
 * The chrome-storage stub is shared across all test wallets in this process,
 * so a contact saved for one wallet already exists for the next — in that case
 * run the boot-time sync that pushes stored contacts into THIS wallet's PXE.
 */
async function registerSenderFor(wallet: AztecWallet, addr: AztecAddress, label: string) {
    try {
        await addContact(network.id, { address: addr.toString(), label, source: "manual" }, wallet);
    } catch (err) {
        if (!(err instanceof Error) || !/already exists/i.test(err.message)) throw err;
        await syncContactsToPxe(network.id, wallet);
    }
}

describe("sandbox e2e — full wallet lifecycle", () => {
    beforeAll(async () => {
        resetChromeStorage();
        await assertSandboxUp();

        const accounts = await getInitialTestAccountsData();
        if (accounts.length < 2) throw new Error("Sandbox did not expose two test accounts.");

        [walletA, walletB] = await Promise.all([
            createBrowserWallet(network, TEST_OVERRIDES),
            createBrowserWallet(network, TEST_OVERRIDES),
        ]);

        const a = accounts[0];
        const b = accounts[1];
        const mgrA = await walletA.createSchnorrAccount(a.secret, a.salt, a.signingKey, "alice");
        const mgrB = await walletB.createSchnorrAccount(b.secret, b.salt, b.signingKey, "bob");
        alice = mgrA.address;
        bob = mgrB.address;
    }, 300_000);

    afterAll(async () => {
        await Promise.allSettled([walletA?.stop(), walletB?.stop(), walletC?.stop()]);
    });

    it("funded test accounts are deployed and hold fee juice", async () => {
        const meta = await walletA.getContractMetadata(alice);
        expect(meta.initializationStatus).toBe(ContractInitializationStatus.INITIALIZED);

        const fee = await getTokenBalance(walletA, alice, FEE_JUICE_ENTRY);
        expect(fee.public).toBeGreaterThan(0n);
    });

    it("deploys a token with initial public supply", async () => {
        const result = await deployToken({
            wallet: walletA,
            network,
            deployer: alice,
            name: "E2E Token",
            symbol: "E2E",
            decimals: DECIMALS,
            initialSupply: u(1_000_000),
            initialSupplyMode: "public",
            keepMinterRole: true,
        });
        expect(result.address).toBeDefined();
        expect(result.txHash).toMatch(/^0x[0-9a-f]+$/i);
        tokenAddress = result.address;
        token = {
            address: tokenAddress.toString(),
            symbol: "E2E",
            name: "E2E Token",
            decimals: DECIMALS,
            kind: "token",
        };
    });

    it("reads public balance after deploy+mint", async () => {
        const bal = await waitFor(
            async () => {
                const b = await balances(walletA, alice);
                return b.public === u(1_000_000) ? b : undefined;
            },
            { label: "alice public balance = 1,000,000 E2E" },
        );
        expect(bal.private).toBe(0n);
    });

    it("deployer is admin and minter", async () => {
        const auth = await getMintAuthority(walletA, tokenAddress, alice);
        expect(auth.isAdmin).toBe(true);
        expect(auth.isMinter).toBe(true);
        expect(auth.admin).toBe(alice.toString());
    });

    it("mints to public", async () => {
        await mintToken({
            wallet: walletA,
            network,
            minter: alice,
            tokenAddress,
            to: alice,
            amount: u(500_000),
            mode: "public",
        });
        await waitFor(
            async () => (await balances(walletA, alice)).public === u(1_500_000),
            { label: "public balance reflects mint_to_public" },
        );
    });

    it("mints to private", async () => {
        await mintToken({
            wallet: walletA,
            network,
            minter: alice,
            tokenAddress,
            to: alice,
            amount: u(250_000),
            mode: "private",
        });
        await waitFor(
            async () => (await balances(walletA, alice)).private === u(250_000),
            { label: "private balance reflects mint_to_private" },
        );
    });

    it("shields: public → private", async () => {
        await shield({ wallet: walletA, network, sender: alice, tokenAddress, amount: u(100_000) });
        await waitFor(
            async () => {
                const b = await balances(walletA, alice);
                return b.public === u(1_400_000) && b.private === u(350_000);
            },
            { label: "balances reflect shield" },
        );
    });

    it("unshields: private → public", async () => {
        await unshield({ wallet: walletA, network, sender: alice, tokenAddress, amount: u(50_000) });
        await waitFor(
            async () => {
                const b = await balances(walletA, alice);
                return b.public === u(1_450_000) && b.private === u(300_000);
            },
            { label: "balances reflect unshield" },
        );
    });

    it("sends PRIVATELY to an independent wallet, which discovers the note", async () => {
        // Bob must register alice as a known sender for tag-stream discovery —
        // this is exactly what the wallet's contacts flow does.
        await registerSenderFor(walletB, alice, "Alice");

        const { txHash } = await transfer({
            wallet: walletA,
            network,
            sender: alice,
            tokenAddress,
            to: bob,
            amount: u(10_000),
            mode: "private",
        });
        expect(txHash).toMatch(/^0x[0-9a-f]+$/i);

        const bobBal = await waitFor(
            async () => {
                const b = await balances(walletB, bob);
                return b.private === u(10_000) ? b : undefined;
            },
            { label: "bob discovers the incoming private note", timeoutMs: 180_000 },
        );
        expect(bobBal.public).toBe(0n);

        await waitFor(
            async () => (await balances(walletA, alice)).private === u(290_000),
            { label: "alice private balance debited" },
        );
    });

    it("sends PUBLICLY to the independent wallet", async () => {
        await transfer({
            wallet: walletA,
            network,
            sender: alice,
            tokenAddress,
            to: bob,
            amount: u(5_000),
            mode: "public",
        });
        await waitFor(
            async () => (await balances(walletB, bob)).public === u(5_000),
            { label: "bob public balance credited" },
        );
        await waitFor(
            async () => (await balances(walletA, alice)).public === u(1_445_000),
            { label: "alice public balance debited" },
        );
    });

    it("rejects zero amounts locally (no fee wasted)", async () => {
        await expect(
            transfer({ wallet: walletA, network, sender: alice, tokenAddress, to: bob, amount: 0n, mode: "private" }),
        ).rejects.toThrow(/greater than zero/);
        await expect(
            shield({ wallet: walletA, network, sender: alice, tokenAddress, amount: 0n }),
        ).rejects.toThrow(/greater than zero/);
        await expect(
            mintToken({ wallet: walletA, network, minter: alice, tokenAddress, to: alice, amount: 0n, mode: "public" }),
        ).rejects.toThrow(/greater than zero/);
    });

    it("rejects transfers exceeding balance at simulation (private and public)", async () => {
        await expect(
            transfer({
                wallet: walletA, network, sender: alice, tokenAddress, to: bob,
                amount: u(100_000_000), mode: "private",
            }),
        ).rejects.toThrow();
        await expect(
            transfer({
                wallet: walletA, network, sender: alice, tokenAddress, to: bob,
                amount: u(100_000_000), mode: "public",
            }),
        ).rejects.toThrow();
    });

    it("rejects a non-minter minting", async () => {
        await expect(
            mintToken({
                wallet: walletB, network, minter: bob, tokenAddress, to: bob,
                amount: u(1), mode: "public",
            }),
        ).rejects.toThrow();
    });

    it("rejects operating on a token that is not deployed", async () => {
        const ghost = AztecAddress.fromBigInt(0xdeadbeefn);
        await expect(ensureTokenRegistered(walletA, ghost)).rejects.toThrow(/not deployed/i);
    });

    it("NEW-USER JOURNEY: fresh account receives privately while undeployed", async () => {
        walletC = await createBrowserWallet(network, TEST_OVERRIDES);
        // A RANDOM mnemonic per run: the sandbox chain persists across runs, so
        // a fixed phrase would arrive already-initialized on the second run and
        // stop exercising the genuine new-user path.
        const { newMnemonic } = await import("../../src/lib/vault/mnemonic");
        const seed = mnemonicToSeed(newMnemonic());
        const { secret, salt } = await deriveAccount(seed, 0);
        freshManager = await walletC.createSchnorrAccount(secret, salt, undefined, "main");
        fresh = freshManager.address;

        const meta = await walletC.getContractMetadata(fresh);
        expect(meta.initializationStatus).not.toBe(ContractInitializationStatus.INITIALIZED);

        // The fresh wallet registers alice (the expected payer) — the Receive
        // screen's "add the sender" flow.
        await registerSenderFor(walletC, alice, "Alice");

        // Alice pays the fresh, UNDEPLOYED address privately.
        await transfer({
            wallet: walletA,
            network,
            sender: alice,
            tokenAddress,
            to: fresh,
            amount: u(1_000),
            mode: "private",
        });

        await waitFor(
            async () => (await balances(walletC, fresh)).private === u(1_000),
            { label: "fresh undeployed account discovers its incoming private note", timeoutMs: 180_000 },
        );
    }, 300_000);

    it("NEW-USER JOURNEY: bridges L1 fee juice to the fresh account", async () => {
        const claim = await bridgeFeeJuice({
            wallet: walletC,
            network,
            recipient: fresh,
            amount: SANDBOX_MINT_AMOUNT, // sandbox handler mints exactly this
            provider: anvilProvider(),
            mint: true,
        });
        expect(claim.claimSecret).toMatch(/^0x/);

        // The claim is consumable only once the message is provably in the tree
        // AT THE PXE'S SYNCED BLOCK. Messages enter the in-tree an inbox-lag's
        // worth of epochs (several blocks) after the deposit, and the sandbox
        // only advances blocks when txs flow — so produce a small tx per poll.
        await waitFor(
            async () => {
                await transfer({
                    wallet: walletA, network, sender: alice, tokenAddress, to: bob,
                    amount: u(1), mode: "public",
                });
                return (await listReadyClaims(walletC, network.id, fresh)).length > 0;
            },
            {
                label: "bridged fee-juice claim visible at walletC's synced tip",
                timeoutMs: 600_000,
                intervalMs: 1_000,
            },
        );
    }, 720_000);

    it("NEW-USER JOURNEY: deploys the account contract paying with the claim, then spends", async () => {
        const fee = await waitFor(
            async () => {
                const f = await resolveFeePaymentMethod(walletC, network, fresh);
                return f.label === "claim" ? f : undefined;
            },
            { label: "fee resolution offers the bridge claim", timeoutMs: 120_000 },
        );

        await deployAccountContract({ wallet: walletC, manager: freshManager, feeMethod: fee.method });
        // Mirror the production flow (ensureAccountDeployed): the deploy consumed
        // the one-shot claim, so flag it locally too.
        await markFeeConsumed(fee);

        await waitFor(
            async () => {
                const meta = await walletC.getContractMetadata(fresh);
                return meta.initializationStatus === ContractInitializationStatus.INITIALIZED;
            },
            { label: "fresh account contract reports INITIALIZED" },
        );

        // The account can now spend the private note it received pre-deployment.
        await transfer({
            wallet: walletC,
            network,
            sender: fresh,
            tokenAddress,
            to: alice,
            amount: u(100),
            mode: "private",
        });

        await waitFor(
            async () => (await balances(walletC, fresh)).private === u(900),
            { label: "fresh account spent from its private balance" },
        );
    }, 360_000);
});
