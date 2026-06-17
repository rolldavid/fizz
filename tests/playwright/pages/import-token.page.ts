import { type Page, type Locator, expect } from "@playwright/test";

/**
 * Page object for Import-a-token (src/popup/pages/ImportToken.tsx). Metadata
 * (symbol/name/decimals) auto-resolves from the contract once the address is
 * valid, which enables the "Add {symbol}" button.
 */
export class ImportTokenPage {
    readonly page: Page;
    readonly addressInput: Locator;
    readonly addBtn: Locator;

    constructor(page: Page) {
        this.page = page;
        this.addressInput = page.getByPlaceholder("0x…");
        // "Add token" (disabled) → "Add {symbol}" (enabled once metadata loads).
        this.addBtn = page.getByRole("button", { name: /^Add\b/ });
    }

    async importByAddress(address: string): Promise<void> {
        await this.addressInput.fill(address);
        // Wait for the contract lookup to resolve and enable Add.
        await expect(this.addBtn).toBeEnabled({ timeout: 90_000 });
        await this.addBtn.click();
        await expect(this.page.getByText(/imported/)).toBeVisible({ timeout: 30_000 });
    }
}
