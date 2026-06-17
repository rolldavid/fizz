import { test, expect } from "../fixtures";
import { loadFundedConfig } from "../accounts";
import { NETWORK_NAMES } from "../constants";
import { importWallet } from "../funded";
import { HomePage } from "../pages/home.page";
import { ConvertPage } from "../pages/convert.page";

/**
 * Single funded account, end-to-end on a LIVE network (alpha/mainnet by config).
 *
 * Read-only coverage (boot, balances, receive, history, token import) runs
 * whenever funded accounts are configured. The Convert test WRITES on-chain and
 * spends real fees, so it additionally requires PW_SPEND=1.
 */
const cfg = loadFundedConfig();
const SPEND = !!process.env.PW_SPEND;

test.describe("funded — single account (live)", () => {
    test.skip(!cfg, "no funded accounts configured — see tests/playwright/.accounts.example.json");
    test.describe.configure({ timeout: 600_000 });

    test("imports funded wallet A and shows a positive gas balance on the live network", async ({
        popup,
    }) => {
        const c = cfg!;
        await importWallet(popup, c.a.mnemonic, c.a.password);
        const home = new HomePage(popup);
        await home.waitForReady();
        await home.setNetwork(c.network);

        await expect(home.networkButton).toContainText(NETWORK_NAMES[c.network]);
        expect(await home.ownAddress()).toMatch(/^0x[0-9a-f]{40,}$/i);
        // Loaded with AZTEC → the gas line must read a positive balance.
        expect(await home.gasBalance()).toBeGreaterThan(0);
    });

    test("Receive shows the funded account's address", async ({ popup }) => {
        const c = cfg!;
        await importWallet(popup, c.a.mnemonic, c.a.password);
        const home = new HomePage(popup);
        await home.waitForReady();
        await home.setNetwork(c.network);

        await home.goto("receive");
        await expect(popup.getByText("Share your address")).toBeVisible();
        await expect(popup.getByRole("button", { name: "Copy address" })).toBeVisible();
    });

    test("Transaction history opens", async ({ popup }) => {
        const c = cfg!;
        await importWallet(popup, c.a.mnemonic, c.a.password);
        const home = new HomePage(popup);
        await home.waitForReady();
        await home.setNetwork(c.network);

        await home.gotoHistory();
        // The gas line is Home-only; its absence confirms we navigated away.
        await expect(home.gasLine).toBeHidden();
    });

    test("imports the configured token and shows it as a balance row", async ({ popup }) => {
        const c = cfg!;
        test.skip(!c.token, "no token configured (cfg.token)");
        await importWallet(popup, c.a.mnemonic, c.a.password);
        const home = new HomePage(popup);
        await home.waitForReady();
        await home.setNetwork(c.network);

        await home.importToken(c.token!.address);
        const symbol = c.token!.symbol ?? "";
        await home.privateTab.click();
        await expect(popup.locator(".token-row", { hasText: symbol }).first()).toBeVisible();
    });

    test("converts a small amount between private and public on a funded account (spends fees)", async ({
        popup,
    }) => {
        const c = cfg!;
        test.skip(!c.token, "no token configured (cfg.token)");
        test.skip(!SPEND, "set PW_SPEND=1 to run write tests that spend real fees");
        const symbol = c.token!.symbol ?? "";
        const CONVERT = 0.001;

        await importWallet(popup, c.a.mnemonic, c.a.password);
        const home = new HomePage(popup);
        await home.waitForReady();
        await home.setNetwork(c.network);

        // Look at the configured accounts (else account 0) and pick the first
        // account+side that actually holds >= the amount we want to convert.
        const indices =
            c.accounts && c.accounts.length ? await home.resolveAccountIndices(c.accounts) : [0];
        let chosen: { index: number; side: "private" | "public" } | null = null;
        for (const index of indices) {
            await home.switchToAccount(index);
            await home.importToken(c.token!.address);
            const priv = await home.tokenBalance(symbol, "private");
            const pub = await home.tokenBalance(symbol, "public");
            if (priv >= CONVERT) {
                chosen = { index, side: "private" };
                break;
            }
            if (pub >= CONVERT) {
                chosen = { index, side: "public" };
                break;
            }
        }
        test.skip(!chosen, `no configured account holds >= ${CONVERT} ${symbol} to convert`);

        await home.switchToAccount(chosen!.index);
        await home.startConvert(symbol, chosen!.side);
        await new ConvertPage(popup).convert(String(CONVERT));
    });
});
