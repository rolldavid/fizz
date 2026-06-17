import { test, expect } from "@playwright/test";
import { launchExtension } from "../harness";
import { loadFundedConfig } from "../accounts";
import { importWallet } from "../funded";
import { HomePage } from "../pages/home.page";
import { SendPage } from "../pages/send.page";

/**
 * BETWEEN TWO SEPARATE WALLETS (different seeds) on a LIVE network. Stands up two
 * independent extension instances (A + B) and transfers the token A → B, adapting
 * to whichever side A holds (private and/or public). Real txs → real fees.
 *
 * Activated only when BOTH `a` and `b` are configured with DIFFERENT mnemonics.
 * For the common same-seed/two-account case, see funded-cross-account.spec.ts.
 */
const cfg = loadFundedConfig();
const SPEND = !!process.env.PW_SPEND;
const twoWallet = !!(cfg && cfg.token && cfg.b && cfg.a.mnemonic !== cfg.b.mnemonic);

test.describe("funded — between two separate wallets (live)", () => {
    test.skip(!twoWallet, "needs two DIFFERENT funded wallets (a + b) and a token");
    test.skip(!SPEND, "set PW_SPEND=1 to run the live transfer (spends real fees)");
    test.describe.configure({ timeout: 1_800_000 });

    test("A sends the token to B (private and/or public, per A's balance)", async () => {
        const c = cfg!;
        const token = c.token!;
        const symbol = token.symbol ?? "";
        const amount = c.amount ?? "1";
        const amountNum = Number(amount);

        const A = await launchExtension();
        const B = await launchExtension();
        try {
            const { page: pa } = await A.openPopup();
            const { page: pb } = await B.openPopup();
            const homeA = new HomePage(pa);
            const homeB = new HomePage(pb);

            await test.step("import + boot both wallets on the live network", async () => {
                await importWallet(pa, c.a.mnemonic, c.a.password);
                await importWallet(pb, c.b!.mnemonic, c.b!.password);
                await homeA.waitForReady();
                await homeA.setNetwork(c.network);
                await homeB.waitForReady();
                await homeB.setNetwork(c.network);
            });

            const addrA = await homeA.ownAddress();
            const addrB = await homeB.ownAddress();
            expect(addrA).not.toEqual(addrB);

            await test.step("both import the token + register contacts", async () => {
                await homeA.importToken(token.address);
                await homeB.importToken(token.address);
                await homeA.addContact("Acct B", addrB);
                await homeB.addContact("Acct A", addrA);
            });

            const aPrivate = await homeA.tokenBalance(symbol, "private");
            const aPublic = await homeA.tokenBalance(symbol, "public");
            test.skip(
                aPrivate < amountNum && aPublic < amountNum,
                `wallet A holds < ${amount} ${symbol} (private=${aPrivate}, public=${aPublic})`,
            );

            const send = async (privacy: "private" | "public") => {
                const before = await homeB.tokenBalance(symbol, privacy);
                await test.step(`A sends ${amount} ${symbol} (${privacy}) to B`, async () => {
                    await homeA.goto("home");
                    await homeA.waitForReady();
                    await homeA.goto("send");
                    const sendPage = new SendPage(pa);
                    await sendPage.selectToken(symbol);
                    await sendPage.pickRecipient("Acct B");
                    await sendPage.setAmount(amount);
                    await sendPage.setPrivacy(privacy);
                    await sendPage.review();
                    await sendPage.confirmAndWaitSent(symbol);
                });
                await test.step(`B observes the ${privacy} balance increase`, async () => {
                    await expect
                        .poll(
                            async () => {
                                await homeB.refreshBalances();
                                return homeB.tokenBalance(symbol, privacy);
                            },
                            { timeout: 900_000, intervals: [15_000] },
                        )
                        .toBeGreaterThan(before);
                });
            };

            if (aPrivate >= amountNum) await send("private");
            if (aPublic >= amountNum) await send("public");
        } finally {
            await A.close();
            await B.close();
        }
    });
});
