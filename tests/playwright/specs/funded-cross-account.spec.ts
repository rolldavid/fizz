import { test, expect } from "../fixtures";
import { loadFundedConfig } from "../accounts";
import { importWallet } from "../funded";
import { HomePage } from "../pages/home.page";
import { SendPage } from "../pages/send.page";

/**
 * BETWEEN TWO ACCOUNTS OF ONE WALLET (same seed, different addresses) on a LIVE
 * network. Imports a single wallet, ensures it has accounts 0 and 1, sets up the
 * token + a contact on each, then transfers the token from whichever account
 * holds it to the other — and watches the receiver's balance rise. Adapts to a
 * private and/or public balance. Real txs → real fees: needs a token + PW_SPEND=1.
 *
 * Activated when only one wallet is configured (no `b`, or `b` == `a`). For two
 * SEPARATE wallets, see funded-cross-wallet.spec.ts.
 */
const cfg = loadFundedConfig();
const SPEND = !!process.env.PW_SPEND;
const sameWallet = !!(cfg && cfg.token && (!cfg.b || cfg.a.mnemonic === cfg.b.mnemonic));

test.describe("funded — between two accounts of one wallet (live)", () => {
    test.skip(!sameWallet, "needs a single funded wallet (a.mnemonic) + token (omit b, or set b == a)");
    test.skip(!SPEND, "set PW_SPEND=1 to run the live transfer (spends real fees)");
    test.describe.configure({ timeout: 1_800_000 });

    test("transfers the token from one account to another (same seed)", async ({ popup }) => {
        const c = cfg!;
        const token = c.token!;
        const symbol = token.symbol ?? "";
        const amount = c.amount ?? "1";
        const amountNum = Number(amount);
        const home = new HomePage(popup);

        await test.step("import the wallet + boot on the live network", async () => {
            await importWallet(popup, c.a.mnemonic, c.a.password);
            await home.waitForReady();
            await home.setNetwork(c.network);
        });

        // Which two HD accounts to use: the configured addresses (resolved to
        // their indices), else accounts 0 and 1.
        let indices: number[];
        if (c.accounts && c.accounts.length >= 2) {
            indices = await home.resolveAccountIndices(c.accounts.slice(0, 2));
        } else {
            await home.ensureAccount(1);
            indices = [0, 1];
        }

        // Per-account setup (token list + balances are per account+network).
        type Acct = { index: number; address: string; priv: number; pub: number };
        const accts: Acct[] = [];
        for (const index of indices) {
            await home.switchToAccount(index);
            const address = await home.ownAddress();
            await home.importToken(token.address);
            const priv = await home.tokenBalance(symbol, "private");
            const pub = await home.tokenBalance(symbol, "public");
            accts.push({ index, address, priv, pub });
        }

        const sender = accts.find((a) => a.priv >= amountNum || a.pub >= amountNum);
        test.skip(!sender, `neither account holds >= ${amount} ${symbol} (fund the token on one account)`);
        const receiver = accts.find((a) => a !== sender)!;
        expect(sender!.address).not.toEqual(receiver.address);

        await test.step("register contacts both ways (needed for private discovery)", async () => {
            await home.switchToAccount(receiver.index);
            await home.addContact("Counterparty", sender!.address);
            await home.switchToAccount(sender!.index);
            await home.addContact("Counterparty", receiver.address);
        });

        const sides: Array<"private" | "public"> = [];
        if (sender!.priv >= amountNum) sides.push("private");
        if (sender!.pub >= amountNum) sides.push("public");

        for (const privacy of sides) {
            await test.step(`account ${sender!.index} → ${receiver.index}: ${amount} ${symbol} (${privacy})`, async () => {
                await home.switchToAccount(receiver.index);
                const before = await home.tokenBalance(symbol, privacy);

                await home.switchToAccount(sender!.index);
                await home.goto("send");
                const send = new SendPage(popup);
                await send.selectToken(symbol);
                await send.pickRecipient("Counterparty");
                await send.setAmount(amount);
                await send.setPrivacy(privacy);
                await send.review();
                await send.confirmAndWaitSent(symbol);

                await home.goto("home");
                await home.waitForReady();
                await home.switchToAccount(receiver.index);
                await expect
                    .poll(
                        async () => {
                            await home.refreshBalances();
                            return home.tokenBalance(symbol, privacy);
                        },
                        { timeout: 900_000, intervals: [15_000] },
                    )
                    .toBeGreaterThan(before);
            });
        }
    });
});
