import { type Page, expect } from "@playwright/test";
import { OnboardingPage } from "./pages/onboarding.page";
import { TEST_PASSPHRASE } from "./constants";

/**
 * Import an existing wallet from its 12-word phrase and a local unlock password,
 * then leave it booting the PXE. The password is the LOCAL unlock secret set on
 * this throwaway profile (defaults to the suite passphrase) — the funds are
 * controlled by the mnemonic, not this password.
 */
export async function importWallet(
    page: Page,
    mnemonic: string,
    password: string = TEST_PASSPHRASE,
): Promise<void> {
    const o = new OnboardingPage(page);
    await o.expectIntro();
    await o.importBtn.click();
    await o.importTextarea.fill(mnemonic);
    await o.continueBtn.click(); // → "Secure your wallet" (import-auth)
    await expect(page.getByText("Secure your wallet")).toBeVisible();
    await o.passwordInput.fill(password);
    await o.confirmInput.fill(password);
    await o.importWalletBtn.click(); // finalize → PXE boot
}
