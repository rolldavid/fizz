import { test, expect } from "../fixtures";
import { createWallet } from "../flows";
import { HomePage } from "../pages/home.page";
import { fatalConsole } from "../constants";

/**
 * LIVE network tier — boots the in-browser PXE against a REAL Aztec node (wasm
 * proving, cross-origin isolation, connect-src CSP, live node connectivity).
 * Off by default; enable with PW_NETWORK=1.
 *
 * The default network is **alpha (Aztec mainnet)** — this is genuine prod: it
 * connects to the live mainnet node (https://aztec.fizzwallet.com) and proves
 * the whole shipped path. A fresh (unfunded) wallet can't transact on mainnet
 * (no sponsored fees there), so the REAL balance/transfer coverage lives in the
 * funded-* specs; this one proves the prod boot + Home render end-to-end.
 */
const RUN = !!process.env.PW_NETWORK;

test.describe("live network (alpha / mainnet boot)", () => {
    test.skip(!RUN, "set PW_NETWORK=1 to boot against the live Aztec network");
    test.describe.configure({ timeout: 600_000 });

    test("a fresh wallet boots on live alpha and reaches Home", async ({
        popup,
        consoleErrors,
    }) => {
        await createWallet(popup);
        const home = new HomePage(popup);
        // Boot loads wasm + circuit artifacts and talks to the mainnet node.
        await home.waitForReady();

        // Confirm we're actually on alpha (mainnet / prod), not a fallback.
        await expect(home.networkButton).toContainText("Aztec Mainnet");

        const body = popup.locator("body");
        await expect(body).toContainText(/Send/);
        await expect(body).toContainText(/Receive/);
        await expect(body).toContainText(/0x[0-9a-f]{4,}/i); // account address

        // CSP / wasm / connectivity regressions surface as console errors.
        expect(fatalConsole(consoleErrors), consoleErrors.join("\n")).toEqual([]);
    });
});
