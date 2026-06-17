import { type Page, expect } from "@playwright/test";
import { OnboardingPage } from "./pages/onboarding.page";
import { TEST_PASSPHRASE } from "./constants";

/**
 * Reusable multi-screen flows shared across specs.
 */

/** Matches whichever screen follows a successful vault creation/unlock: the PXE
 *  "Connecting to…" boot screen, its "Couldn't reach…" error (offline), or Home
 *  ("Need gas?"/"Sponsored") if the boot already completed. Reaching ANY of
 *  these proves the local crypto step succeeded and the app left onboarding —
 *  without depending on a live network. */
export function postAuthScreen(page: Page) {
    return page
        .getByText(/Connecting to/i)
        .or(page.getByText(/Couldn't reach/i))
        .or(page.getByText(/Need gas\?|Sponsored/));
}

/** Create a passphrase wallet and stop once the app has left onboarding (vault
 *  created locally). Does NOT wait for the network boot to finish. */
export async function createWallet(page: Page, passphrase = TEST_PASSPHRASE): Promise<void> {
    const onboarding = new OnboardingPage(page);
    await onboarding.expectIntro();
    await onboarding.beginCreateWithPassphrase(passphrase);
    await onboarding.finalizeCreate();
    await expect(postAuthScreen(page)).toBeVisible({ timeout: 30_000 });
}

/** Create a wallet, then lock it via the boot screen ("Cancel and lock", or
 *  "Lock wallet" in the boot-error state). Unlock submits use page.keyboard (not
 *  locator.press), which is unaffected by the brief boot-driven remount of the
 *  lock screen — so no page reload is needed (and reloading the popup mid-test
 *  trips a wasm-crypto-after-reload artifact in the harness; avoid it). */
export async function createThenLock(page: Page, passphrase = TEST_PASSPHRASE): Promise<void> {
    await createWallet(page, passphrase);
    const cancel = page.getByRole("button", { name: "Cancel and lock" });
    const lock = page.getByRole("button", { name: "Lock wallet" });
    await expect(cancel.or(lock)).toBeVisible({ timeout: 60_000 });
    if (await cancel.isVisible()) await cancel.click();
    else await lock.click();
    await expect(page.getByText("Locked tight")).toBeVisible({ timeout: 30_000 });
}
