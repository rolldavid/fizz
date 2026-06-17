import { type Page, type Locator, expect } from "@playwright/test";

/**
 * Page object for the Convert (shield / unshield) screen
 * (src/popup/pages/Convert.tsx). Reached from a token row's "Swap to …" menu;
 * moves a balance between the account's own private and public sides.
 */
export class ConvertPage {
    readonly page: Page;
    readonly amountInput: Locator;
    readonly useFullBtn: Locator;
    readonly submitBtn: Locator;

    constructor(page: Page) {
        this.page = page;
        this.amountInput = page.getByPlaceholder("0.0");
        this.useFullBtn = page.getByRole("button", { name: /^Use full/ });
        // "Make private" / "Make public" — the screen's primary submit.
        this.submitBtn = page.getByRole("button", { name: /^Make (private|public)$/ });
    }

    /** Convert `amount`; waits for the "Converted to …" success screen. Spends
     *  real fees on a live network. */
    async convert(amount: string, timeout = 600_000): Promise<void> {
        await this.amountInput.fill(amount);
        await this.submitBtn.click();
        await expect(this.page.getByText(/Converted to/)).toBeVisible({ timeout });
    }
}
