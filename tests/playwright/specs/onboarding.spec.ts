import { test, expect } from "../fixtures";
import { OnboardingPage } from "../pages/onboarding.page";
import { postAuthScreen } from "../flows";
import { TEST_PASSPHRASE, TEST_MNEMONIC } from "../constants";

/**
 * Onboarding flows. All LOCAL — vault crypto runs in-extension, no node is
 * contacted, so these are deterministic regardless of network state.
 */
test.describe("onboarding", () => {
    test("intro screen offers create + import", async ({ popup }) => {
        const o = new OnboardingPage(popup);
        await o.expectIntro();
        await expect(popup.getByText(/Tokens with sparkle/i)).toBeVisible();
    });

    test("Continue is gated on a strong, confirmed passphrase", async ({ popup }) => {
        const o = new OnboardingPage(popup);
        await o.createBtn.click();
        await expect(o.continueBtn).toBeDisabled();

        // Weak password → still disabled.
        await o.passwordInput.fill("short");
        await o.confirmInput.fill("short");
        await expect(o.continueBtn).toBeDisabled();

        // Strong but mismatched confirmation → still disabled.
        await o.passwordInput.fill(TEST_PASSPHRASE);
        await o.confirmInput.fill("does-not-match-the-above");
        await expect(o.continueBtn).toBeDisabled();

        // Strong + matching → enabled.
        await o.confirmInput.fill(TEST_PASSPHRASE);
        await expect(o.continueBtn).toBeEnabled();
    });

    test("create flow reveals 12 recovery words and creates the vault", async ({ popup }) => {
        const o = new OnboardingPage(popup);
        await o.beginCreateWithPassphrase(TEST_PASSPHRASE);

        const words = await o.recoveryWords();
        expect(words).toHaveLength(12);
        for (const w of words) expect(w).toMatch(/^[a-z]+$/);

        await o.finalizeCreate();
        // Leaving onboarding for the boot screen proves the vault was created.
        await expect(postAuthScreen(popup)).toBeVisible({ timeout: 30_000 });
    });

    test("import rejects an invalid phrase", async ({ popup }) => {
        const o = new OnboardingPage(popup);
        await o.importBtn.click();
        await o.importTextarea.fill("not a real mnemonic phrase at all nope nope nope");
        await o.continueBtn.click();
        await expect(o.error).toContainText(/valid 12-word phrase/i);
    });

    test("import accepts a valid phrase and advances to secure-your-wallet", async ({
        popup,
    }) => {
        const o = new OnboardingPage(popup);
        await o.importBtn.click();
        await o.importTextarea.fill(TEST_MNEMONIC);
        await o.continueBtn.click();
        await expect(popup.getByText("Secure your wallet")).toBeVisible();
        await expect(o.importWalletBtn).toBeVisible();
    });

    test("Back from the auth step returns to the intro", async ({ popup }) => {
        const o = new OnboardingPage(popup);
        await o.createBtn.click();
        await expect(popup.getByText("Secure your wallet")).toBeVisible();
        await o.backBtn.click();
        await o.expectIntro();
    });
});
