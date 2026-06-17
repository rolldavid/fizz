import { type Page, type Locator, expect } from "@playwright/test";

/**
 * Page object for the Unlock screen (src/popup/pages/Unlock.tsx) — shown when
 * the wallet exists but is locked.
 */
export class UnlockPage {
    readonly page: Page;
    readonly heading: Locator;
    readonly passphraseInput: Locator;
    readonly unlockBtn: Locator;
    readonly forgetBtn: Locator;
    readonly error: Locator;

    constructor(page: Page) {
        this.page = page;
        this.heading = page.getByText("Locked tight");
        this.passphraseInput = page.locator('input[type="password"]');
        // exact: avoid matching "Unlock with passkey".
        this.unlockBtn = page.getByRole("button", { name: "Unlock", exact: true });
        this.forgetBtn = page.getByRole("button", {
            name: "Forget wallet on this device",
        });
        this.error = page.locator(".error");
    }

    async expectLocked(): Promise<void> {
        await expect(this.heading).toBeVisible();
        await expect(this.unlockBtn).toBeVisible();
    }

    async unlock(passphrase: string): Promise<void> {
        await this.passphraseInput.fill(passphrase);
        await this.passphraseInput.focus();
        // Submit with the PAGE keyboard (not locator.press): submitting unlocks,
        // which re-renders/unmounts this screen, and locator.press retries when
        // its target element churns mid-action → spurious timeout. page.keyboard
        // fires Enter at the focused input and doesn't re-resolve the element.
        // The input's onKeyDown handles Enter → unlock.
        await this.page.keyboard.press("Enter");
    }
}
