import { type Page, type Locator, expect } from "@playwright/test";

type Privacy = "private" | "public";

/**
 * Page object for the Send screen (src/popup/pages/Send.tsx). Recipients are
 * CONTACTS ONLY (no raw-address input) — add the contact first, then pick it.
 */
export class SendPage {
    readonly page: Page;
    readonly tokenSelect: Locator;
    readonly comboInput: Locator;
    readonly amountInput: Locator;
    readonly privateTab: Locator;
    readonly publicTab: Locator;
    readonly reviewBtn: Locator;
    readonly confirmBtn: Locator;
    readonly error: Locator;

    constructor(page: Page) {
        this.page = page;
        // Scope to the "Token" field so the header network <select> isn't matched.
        this.tokenSelect = page.locator('div.field:has(label:text-is("Token")) select');
        this.comboInput = page.locator(".contact-combo input");
        this.amountInput = page.getByPlaceholder("0.0");
        this.privateTab = page.getByRole("button", { name: "Private", exact: true });
        this.publicTab = page.getByRole("button", { name: "Public", exact: true });
        this.reviewBtn = page.getByRole("button", { name: "Review send" });
        this.confirmBtn = page.getByRole("button", { name: "Confirm & send" });
        this.error = page.locator(".error");
    }

    /** Select the token whose option text starts with `symbol` (option value is
     *  the contract address). No-op if it's already the only/selected token. */
    async selectToken(symbol: string): Promise<void> {
        const option = this.tokenSelect.locator("option", { hasText: symbol });
        const value = await option.first().getAttribute("value");
        if (value) await this.tokenSelect.selectOption(value);
    }

    async pickRecipient(label: string): Promise<void> {
        await this.comboInput.click();
        await this.page.getByRole("option").filter({ hasText: label }).first().click();
    }

    async setAmount(amount: string): Promise<void> {
        await this.amountInput.fill(amount);
    }

    async setPrivacy(privacy: Privacy): Promise<void> {
        await (privacy === "private" ? this.privateTab : this.publicTab).click();
    }

    async review(): Promise<void> {
        await this.reviewBtn.click();
    }

    /** Confirm the modal and wait for the post-send confirmation screen. Proving
     *  + inclusion (and a first-tx account activation) can take many minutes. */
    async confirmAndWaitSent(symbol: string, timeout = 600_000): Promise<void> {
        await expect(this.confirmBtn).toBeVisible();
        await this.confirmBtn.click();
        await expect(this.page.getByText(new RegExp(`${symbol} sent`))).toBeVisible({ timeout });
    }
}
