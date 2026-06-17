import { type Page, type Locator, expect } from "@playwright/test";

/**
 * Page object for the Onboarding screen (src/popup/pages/Onboarding.tsx).
 * Locators prefer user-facing roles/text over brittle CSS, except `.mnemonic-word`
 * which is the component's own stable hook for the recovery-phrase grid.
 */
export class OnboardingPage {
    readonly page: Page;
    readonly createBtn: Locator;
    readonly importBtn: Locator;
    readonly passwordInput: Locator;
    readonly confirmInput: Locator;
    readonly continueBtn: Locator;
    readonly usePasskeyBtn: Locator;
    readonly words: Locator;
    readonly savedBtn: Locator;
    readonly importTextarea: Locator;
    readonly importWalletBtn: Locator;
    readonly backBtn: Locator;
    readonly error: Locator;

    constructor(page: Page) {
        this.page = page;
        this.createBtn = page.getByRole("button", { name: "Create new wallet" });
        this.importBtn = page.getByRole("button", { name: "Import 12-word phrase" });
        this.passwordInput = page.locator('input[type="password"]').first();
        this.confirmInput = page.locator('input[type="password"]').nth(1);
        this.continueBtn = page.getByRole("button", { name: "Continue" });
        this.usePasskeyBtn = page.getByRole("button", { name: "Use a passkey" });
        this.words = page.locator(".mnemonic-word");
        this.savedBtn = page.getByRole("button", { name: /I've saved it/ });
        this.importTextarea = page.locator("textarea");
        this.importWalletBtn = page.getByRole("button", { name: "Import wallet" });
        this.backBtn = page.getByRole("button", { name: "Back" });
        this.error = page.locator(".error");
    }

    async expectIntro(): Promise<void> {
        await expect(this.createBtn).toBeVisible();
        await expect(this.importBtn).toBeVisible();
    }

    /** intro → create-auth → enter a strong, matching passphrase → Continue →
     *  the 12-word recovery step (asserts the grid rendered). */
    async beginCreateWithPassphrase(passphrase: string): Promise<void> {
        await this.createBtn.click();
        await this.passwordInput.fill(passphrase);
        await this.confirmInput.fill(passphrase);
        await expect(this.continueBtn).toBeEnabled();
        await this.continueBtn.click();
        await expect(this.words).toHaveCount(12);
    }

    /** Read the 12 recovery words, stripping the "N. " ordinal prefix. */
    async recoveryWords(): Promise<string[]> {
        const raw = await this.words.allInnerTexts();
        return raw.map((t) => t.replace(/^\d+\.\s*/, "").trim());
    }

    /** create-words → finalize. Creates the vault; the app then boots the PXE. */
    async finalizeCreate(): Promise<void> {
        await this.savedBtn.click();
    }
}
