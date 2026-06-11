/**
 * TESTNET E2E — the wallet's real lib code against the PUBLIC alpha-testnet
 * with REAL client-side proofs. Opt-in (slow, touches a live network):
 *
 *   TESTNET=1 yarn test:e2e
 *
 * Uses the persistent smoke account from scripts/testnet-smoke.mjs
 * (/tmp/aztec-testnet-smoke.json — run that script once first, or set
 * TESTNET_SMOKE_MNEMONIC + TESTNET_TOKEN_ADDRESS).
 *
 * The L1 bridge test additionally requires TESTNET_BRIDGE=1 and
 * TESTNET_L1_PRIVATE_KEY (a funded Sepolia key; gas-only — the fee asset is
 * minted by the handler). It bridges ONE fixed handler mint, never more.
 *
 * Covers, beyond what testnet-smoke proved (account deploy, token deploy,
 * mint_to_private — all sponsored):
 *   - unshield / shield on testnet (sponsored)
 *   - private transfer to an INDEPENDENT fresh wallet + note discovery
 *   - public transfer
 *   - mint authority reads
 *   - (gated) L1→L2 fee-juice bridge with claim readiness at the proven tip
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AztecAddress } from "@aztec/aztec.js/addresses";

import { getNetwork } from "../../src/lib/aztec/networks";
import { createBrowserWallet, deriveAccount, type AztecWallet } from "../../src/lib/aztec/wallet";
import { getMintAuthority, mintToken } from "../../src/lib/aztec/mint";
import { shield, transfer, unshield } from "../../src/lib/aztec/transfer";
import { getTokenBalance } from "../../src/lib/aztec/balances";
import { addContact } from "../../src/lib/aztec/contacts";
import { bridgeFeeJuice, listReadyClaims } from "../../src/lib/aztec/bridge";
import { isSponsoredFPCAvailable } from "../../src/lib/aztec/fee";
import { mnemonicToSeed } from "../../src/lib/vault/mnemonic";
import { type TokenEntry } from "../../src/lib/aztec/tokens";
import { sepoliaKeyProvider, waitFor } from "./helpers";
import { resetChromeStorage } from "../setup/chrome-stub";

const RUN = !!process.env.TESTNET;
const RUN_BRIDGE = RUN && !!process.env.TESTNET_BRIDGE && !!process.env.TESTNET_L1_PRIVATE_KEY;
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const STATE_FILE = "/tmp/aztec-testnet-smoke.json";

function smokeState(): { mnemonic: string; tokenAddress: string } {
    const mnemonic = process.env.TESTNET_SMOKE_MNEMONIC;
    const tokenAddress = process.env.TESTNET_TOKEN_ADDRESS;
    if (mnemonic && tokenAddress) return { mnemonic, tokenAddress };
    if (!existsSync(STATE_FILE)) {
        throw new Error(
            `No testnet smoke state. Run \`node scripts/testnet-smoke.mjs\` once, or set ` +
                `TESTNET_SMOKE_MNEMONIC and TESTNET_TOKEN_ADDRESS.`,
        );
    }
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!state.mnemonic || !state.tokenAddress) {
        throw new Error(`Smoke state at ${STATE_FILE} is incomplete: ${JSON.stringify(state)}`);
    }
    return state;
}

const network = getNetwork("testnet");
// Real proofs on testnet; ephemeral stores so each run resyncs cleanly.
const OVERRIDES = { proverEnabled: true, ephemeral: true } as const;

let walletA: AztecWallet; // smoke account (deployed, holds SMK private balance)
let walletB: AztecWallet; // independent fresh wallet — receive-side
let main: AztecAddress;
let receiver: AztecAddress;
let token: TokenEntry;
let tokenAddress: AztecAddress;

const u = (n: number | bigint) => BigInt(n) * 10n ** 6n; // SMK has 6 decimals

describe.skipIf(!RUN)("testnet e2e — sponsored flows with real proofs", () => {
    beforeAll(async () => {
        resetChromeStorage();
        const state = smokeState();
        tokenAddress = AztecAddress.fromString(state.tokenAddress);
        token = {
            address: state.tokenAddress,
            symbol: "SMK",
            name: "Smoke Token",
            decimals: 6,
            kind: "token",
        };

        [walletA, walletB] = await Promise.all([
            createBrowserWallet(network, OVERRIDES),
            createBrowserWallet(network, OVERRIDES),
        ]);

        const seed = mnemonicToSeed(state.mnemonic);
        const a0 = await deriveAccount(seed, 0);
        const mgrA = await walletA.createSchnorrAccount(a0.secret, a0.salt, undefined, "main");
        main = mgrA.address;

        // Independent receiver: SAME mnemonic, DIFFERENT account index — but in
        // a completely separate wallet/PXE instance (true two-party flow).
        const a1 = await deriveAccount(seed, 1);
        const mgrB = await walletB.createSchnorrAccount(a1.secret, a1.salt, undefined, "recv");
        receiver = mgrB.address;
    }, 600_000);

    afterAll(async () => {
        await Promise.allSettled([walletA?.stop(), walletB?.stop()]);
    });

    it("sponsored FPC is live on testnet (on-chain probe)", async () => {
        await expect(isSponsoredFPCAvailable(walletA)).resolves.toBe(true);
    });

    it("smoke account is admin+minter and holds its private mint", async () => {
        const auth = await getMintAuthority(walletA, tokenAddress, main);
        expect(auth.isMinter).toBe(true);
        expect(auth.isAdmin).toBe(true);
        const bal = await getTokenBalance(walletA, main, token);
        expect(bal.private).toBeGreaterThan(0n);
    }, 600_000);

    it("unshields on testnet (sponsored)", async () => {
        const before = await getTokenBalance(walletA, main, token);
        await unshield({ wallet: walletA, network, sender: main, tokenAddress, amount: u(200) });
        await waitFor(
            async () => {
                const b = await getTokenBalance(walletA, main, token);
                return b.public === before.public + u(200) && b.private === before.private - u(200);
            },
            { label: "unshield reflected on testnet", timeoutMs: 900_000, intervalMs: 15_000 },
        );
    }, 1_200_000);

    it("shields on testnet (sponsored)", async () => {
        const before = await getTokenBalance(walletA, main, token);
        await shield({ wallet: walletA, network, sender: main, tokenAddress, amount: u(50) });
        await waitFor(
            async () => {
                const b = await getTokenBalance(walletA, main, token);
                return b.public === before.public - u(50) && b.private === before.private + u(50);
            },
            { label: "shield reflected on testnet", timeoutMs: 900_000, intervalMs: 15_000 },
        );
    }, 1_200_000);

    it("mints to public on testnet (sponsored)", async () => {
        const before = await getTokenBalance(walletA, main, token);
        await mintToken({
            wallet: walletA, network, minter: main, tokenAddress, to: main,
            amount: u(500), mode: "public",
        });
        await waitFor(
            async () => (await getTokenBalance(walletA, main, token)).public === before.public + u(500),
            { label: "public mint reflected", timeoutMs: 900_000, intervalMs: 15_000 },
        );
    }, 1_200_000);

    it("sends PRIVATELY to an independent wallet on testnet; receiver discovers", async () => {
        await addContact(network.id, "e2e-wallet-b", { address: main.toString(), label: "Main", source: "manual" }, walletB);

        // DELTA-based: the receiver account is PERSISTENT on testnet, so its
        // balance accumulates across runs — exact-equality assertions pass only
        // on the first-ever run and then "fail" forever (learned the hard way).
        const before = await getTokenBalance(walletB, receiver, token);

        await transfer({
            wallet: walletA, network, sender: main, tokenAddress, to: receiver,
            amount: u(25), mode: "private",
        });

        await waitFor(
            async () => {
                const b = await getTokenBalance(walletB, receiver, token);
                return b.private === before.private + u(25);
            },
            { label: "receiver discovers private note on testnet", timeoutMs: 1_200_000, intervalMs: 20_000 },
        );
    }, 1_500_000);

    it("sends PUBLICLY on testnet", async () => {
        const before = await getTokenBalance(walletB, receiver, token);
        await transfer({
            wallet: walletA, network, sender: main, tokenAddress, to: receiver,
            amount: u(10), mode: "public",
        });
        await waitFor(
            async () => (await getTokenBalance(walletB, receiver, token)).public === before.public + u(10),
            { label: "public transfer reflected for receiver", timeoutMs: 900_000, intervalMs: 15_000 },
        );
    }, 1_200_000);
});

describe.skipIf(!RUN_BRIDGE)("testnet e2e — L1 fee-juice bridge (Sepolia)", () => {
    it("bridges ONE handler mint from Sepolia and the claim becomes consumable at the synced tip", async () => {
        const state = smokeState();
        const wallet = await createBrowserWallet(network, OVERRIDES);
        try {
            const seed = mnemonicToSeed(state.mnemonic);
            const a0 = await deriveAccount(seed, 0);
            const mgr = await wallet.createSchnorrAccount(a0.secret, a0.salt, undefined, "main");

            // The chrome-storage stub is per-process, so a claim bridged in a
            // previous run would be forgotten and a retry would bridge AGAIN.
            // Persist the claim entry in the smoke state file and re-seed the
            // (encrypted) pending-bridges store from it: ONE bridge, ever.
            const { KEYS } = await import("../../src/lib/storage");
            const { secureSet } = await import("../../src/lib/secureStorage");
            const persisted = (JSON.parse(readFileSync(STATE_FILE, "utf8")) as any).bridgeClaim;
            if (persisted) {
                await secureSet(KEYS.pendingBridges, [persisted]);
            } else {
                const provider = await sepoliaKeyProvider(
                    process.env.TESTNET_L1_PRIVATE_KEY!,
                    SEPOLIA_RPC,
                );
                // ONE fixed-size handler mint (1000e18) — never drains the L1
                // key; it only spends Sepolia gas.
                const entry = await bridgeFeeJuice({
                    wallet,
                    network,
                    recipient: mgr.address,
                    amount: 1000n * 10n ** 18n,
                    provider,
                    mint: true,
                });
                expect(entry.claimSecret).toMatch(/^0x/);
                const cur = JSON.parse(readFileSync(STATE_FILE, "utf8"));
                writeFileSync(STATE_FILE, JSON.stringify({ ...cur, bridgeClaim: entry }, null, 2));
            }

            await waitFor(
                async () => (await listReadyClaims(wallet, network.id, mgr.address)).length > 0,
                {
                    label: "bridged claim visible at the PXE's synced tip on testnet",
                    timeoutMs: 1_800_000,
                    intervalMs: 30_000,
                },
            );
        } finally {
            await wallet.stop();
        }
    }, 2_400_000);
});
