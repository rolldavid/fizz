/**
 * PRESSURE / STRESS e2e — sandbox. Opt-in (slow):
 *
 *   PRESSURE=1 yarn vitest run --project e2e tests/e2e/pressure.test.ts
 *
 * Probes the wallet's behavior at the edges a popup actually hits:
 *   - several tokens imported, balances polled in parallel bursts (popup-open storm)
 *   - balances built from MANY small notes (note discovery + aggregation)
 *   - a transfer that must consume many notes at once (note-selection limits)
 *   - rapid sequential sends (nullifier correctness under churn)
 *   - concurrent simulation storm (PXE under parallel utility calls)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";

import { getNetwork } from "../../src/lib/aztec/networks";
import { createBrowserWallet, type AztecWallet } from "../../src/lib/aztec/wallet";
import { deployToken } from "../../src/lib/aztec/deploy";
import { mintToken } from "../../src/lib/aztec/mint";
import { transfer } from "../../src/lib/aztec/transfer";
import { getTokenBalance } from "../../src/lib/aztec/balances";
import { type TokenEntry } from "../../src/lib/aztec/tokens";
import { assertSandboxUp, waitFor } from "./helpers";
import { resetChromeStorage } from "../setup/chrome-stub";

const RUN = !!process.env.PRESSURE;
const network = getNetwork("sandbox");
const OVERRIDES = { proverEnabled: false, ephemeral: true } as const;

const N_TOKENS = 4;
const N_SMALL_NOTES = 12;
const DECIMALS = 2;
const u = (n: number | bigint) => BigInt(n) * 10n ** BigInt(DECIMALS);

let wallet: AztecWallet;
let alice: AztecAddress;
let bob: AztecAddress;
let tokens: TokenEntry[] = [];

function entry(address: string, i: number): TokenEntry {
    return { address, symbol: `PT${i}`, name: `Pressure ${i}`, decimals: DECIMALS, kind: "token" };
}

describe.skipIf(!RUN)("pressure — sandbox stress", () => {
    beforeAll(async () => {
        resetChromeStorage();
        await assertSandboxUp();
        wallet = await createBrowserWallet(network, OVERRIDES);
        const [a, b] = await getInitialTestAccountsData();
        const mgrA = await wallet.createSchnorrAccount(a.secret, a.salt, a.signingKey, "alice");
        const mgrB = await wallet.createSchnorrAccount(b.secret, b.salt, b.signingKey, "bob");
        alice = mgrA.address;
        bob = mgrB.address;
    }, 300_000);

    afterAll(async () => {
        await wallet?.stop();
    });

    it(`deploys ${N_TOKENS} tokens back-to-back`, async () => {
        for (let i = 0; i < N_TOKENS; i++) {
            const res = await deployToken({
                wallet,
                network,
                deployer: alice,
                name: `Pressure ${i}`,
                symbol: `PT${i}`,
                decimals: DECIMALS,
                initialSupply: u(1_000),
                initialSupplyMode: "public",
                keepMinterRole: true,
            });
            tokens.push(entry(res.address.toString(), i));
        }
        expect(tokens).toHaveLength(N_TOKENS);
    }, 900_000);

    it("survives popup-open balance storms (parallel reads × rounds)", async () => {
        for (let round = 0; round < 3; round++) {
            const results = await Promise.all(
                tokens.map((t) => getTokenBalance(wallet, alice, t)),
            );
            for (const r of results) {
                expect(r.public).toBe(u(1_000));
                expect(r.private).toBe(0n);
            }
        }
    }, 300_000);

    it(`aggregates a balance from ${N_SMALL_NOTES} small notes`, async () => {
        const t = tokens[0];
        const tokenAddress = AztecAddress.fromString(t.address);
        for (let i = 0; i < N_SMALL_NOTES; i++) {
            await mintToken({
                wallet, network, minter: alice, tokenAddress, to: alice,
                amount: u(1), mode: "private",
            });
        }
        await waitFor(
            async () => (await getTokenBalance(wallet, alice, t)).private === u(N_SMALL_NOTES),
            { label: `private balance equals ${N_SMALL_NOTES} aggregated notes`, timeoutMs: 300_000 },
        );
    }, 1_800_000);

    it("handles a transfer that must consume many notes (note-selection limit probe)", async () => {
        const t = tokens[0];
        const tokenAddress = AztecAddress.fromString(t.address);
        // Balance is N_SMALL_NOTES × 1-unit notes. Sending N-2 requires selecting
        // many notes in one tx. Either it works (balances move) or the protocol's
        // per-tx note cap rejects it with a comprehensible error — both are
        // acceptable behaviors, but they must be EXACTLY one of those two.
        const amount = u(N_SMALL_NOTES - 2);
        let capError: string | null = null;
        try {
            await transfer({
                wallet, network, sender: alice, tokenAddress, to: bob,
                amount, mode: "private",
            });
        } catch (e) {
            capError = e instanceof Error ? e.message : String(e);
        }
        if (capError) {
            // Must be the note-selection limitation, not some unrelated failure.
            expect(capError).toMatch(/note|Cannot satisfy|insufficient|max/i);
        } else {
            await waitFor(
                async () => (await getTokenBalance(wallet, alice, t)).private === u(2),
                { label: "many-note transfer debited correctly", timeoutMs: 300_000 },
            );
        }
    }, 900_000);

    it("rapid sequential private sends stay consistent", async () => {
        const t = tokens[1];
        const tokenAddress = AztecAddress.fromString(t.address);
        await mintToken({
            wallet, network, minter: alice, tokenAddress, to: alice,
            amount: u(50), mode: "private",
        });
        await waitFor(
            async () => (await getTokenBalance(wallet, alice, t)).private === u(50),
            { label: "seed private balance for rapid sends" },
        );
        for (let i = 0; i < 4; i++) {
            await transfer({
                wallet, network, sender: alice, tokenAddress, to: bob,
                amount: u(3), mode: "private",
            });
        }
        await waitFor(
            async () => {
                const [a, b] = await Promise.all([
                    getTokenBalance(wallet, alice, t),
                    getTokenBalance(wallet, bob, t),
                ]);
                return a.private === u(50 - 12) && b.private === u(12);
            },
            { label: "rapid sends settle to exact balances", timeoutMs: 300_000 },
        );
    }, 1_800_000);

    it("concurrent simulation storm (20 parallel utility reads)", async () => {
        const reads = Array.from({ length: 20 }, (_, i) =>
            getTokenBalance(wallet, i % 2 ? alice : bob, tokens[i % tokens.length]),
        );
        const results = await Promise.all(reads);
        expect(results).toHaveLength(20);
        for (const r of results) {
            expect(typeof r.public).toBe("bigint");
            expect(typeof r.private).toBe("bigint");
            expect(r.public >= 0n && r.private >= 0n).toBe(true);
        }
    }, 300_000);
});
