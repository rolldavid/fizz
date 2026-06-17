import { type Page, type Locator } from "@playwright/test";

/**
 * Page object for Contacts + its Add dialog (src/popup/pages/Contacts.tsx).
 */
export class ContactsPage {
    readonly page: Page;
    readonly addBtn: Locator;
    readonly labelInput: Locator;
    readonly addressInput: Locator;
    readonly saveBtn: Locator;

    constructor(page: Page) {
        this.page = page;
        this.addBtn = page.getByRole("button", { name: "Add", exact: true });
        this.labelInput = page.getByPlaceholder("e.g. Alice");
        this.addressInput = page.getByPlaceholder("0x…");
        this.saveBtn = page.getByRole("button", { name: "Save", exact: true });
    }

    /** Add a contact. Opens the dialog first if it isn't already showing (it is
     *  shown automatically when arriving from Send's "+ New contact"). */
    async addContact(label: string, address: string): Promise<void> {
        const dialogOpen = await this.labelInput.isVisible().catch(() => false);
        if (!dialogOpen) await this.addBtn.click();
        await this.labelInput.fill(label);
        await this.addressInput.fill(address);
        await this.saveBtn.click();
    }
}
