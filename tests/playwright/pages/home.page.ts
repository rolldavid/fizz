import { type Page, type Locator, expect } from "@playwright/test";
import { NETWORK_NAMES } from "../constants";
import { ContactsPage } from "./contacts.page";
import { ImportTokenPage } from "./import-token.page";

type Tab = "private" | "public";

/**
 * Page object for the unlocked Home screen (src/popup/pages/Home.tsx) and the
 * cross-screen navigation it anchors. Screen transitions use hash routing
 * (`location.hash = "send"`), which the App's hashchange listener turns into a
 * route change WITHOUT a reload — so the live PXE session is preserved (no
 * costly re-boot between steps).
 */
export class HomePage {
    readonly page: Page;
    readonly gasLine: Locator;
    readonly gasAmount: Locator;
    readonly sendBtn: Locator;
    readonly receiveBtn: Locator;
    readonly importBtn: Locator;
    readonly menuBtn: Locator;
    readonly addressDisplay: Locator;
    /** The header network picker — a custom button (NOT a native <select>). */
    readonly networkButton: Locator;
    /** The account-switcher pill (opens the Accounts modal). */
    readonly accountPill: Locator;
    readonly privateTab: Locator;
    readonly publicTab: Locator;

    constructor(page: Page) {
        this.page = page;
        this.gasLine = page.locator(".fee-line");
        this.gasAmount = page.locator(".fee-line-amount");
        this.sendBtn = page.getByRole("button", { name: "Send", exact: true });
        this.receiveBtn = page.getByRole("button", { name: "Receive", exact: true });
        this.importBtn = page.getByRole("button", { name: "+ Import" });
        this.menuBtn = page.getByRole("button", { name: "Menu", exact: true });
        this.addressDisplay = page.locator(".address-display").first();
        this.networkButton = page.getByRole("button", { name: "Switch network" });
        this.accountPill = page.getByRole("button", { name: "Switch account" });
        this.privateTab = page.getByRole("button", { name: "Private Tokens" });
        this.publicTab = page.getByRole("button", { name: "Public Tokens" });
    }

    /** Wait until the PXE has booted and Home rendered (the gas line is the tell). */
    async waitForReady(timeout = 300_000): Promise<void> {
        await expect(this.gasLine).toBeVisible({ timeout });
    }

    /** Switch network via the header picker (re-boots the PXE) — only if different.
     *  The picker is a custom listbox: a button → role=option items by name. */
    async setNetwork(id: string): Promise<void> {
        const name = NETWORK_NAMES[id];
        if (!name) throw new Error(`unknown network id: ${id}`);
        if ((await this.networkButton.innerText()).includes(name)) return; // already there
        await this.networkButton.click();
        await this.page.getByRole("option", { name }).click();
        await this.waitForReady();
    }

    /** The account's full address, read from the `.address-display` title attr. */
    async ownAddress(): Promise<string> {
        const addr = await this.addressDisplay.getAttribute("title");
        if (!addr) throw new Error("could not read own address from Home");
        return addr;
    }

    /** Gas (fee-juice) balance as a number — waits past the loading spinner. */
    async gasBalance(): Promise<number> {
        await expect(this.gasAmount).toContainText(/[0-9]/, { timeout: 120_000 });
        const text = (await this.gasAmount.first().innerText()).replace(/[^0-9.]/g, "");
        return Number.parseFloat(text || "0");
    }

    /** Balance of a token (by symbol) in the given tab. The token row's own
     *  `.balance-sub` label flips to "private"/"public" with the selected tab, so
     *  wait for it to match BEFORE reading the amount — otherwise the value read
     *  can be the previous tab's (the row re-renders a tick after the tab click). */
    async tokenBalance(symbol: string, tab: Tab = "private"): Promise<number> {
        await (tab === "private" ? this.privateTab : this.publicTab).click();
        const row = this.page.locator(".token-row", { hasText: symbol });
        await expect(row.locator(".balance-sub").first()).toHaveText(tab, { timeout: 120_000 });
        const text = (await row.locator(".balance-amount").first().innerText()).replace(/[^0-9.]/g, "");
        return Number.parseFloat(text || "0");
    }

    /** Route to another screen via the hash router (no reload, keeps the PXE). */
    async goto(route: "home" | "send" | "receive" | "history"): Promise<void> {
        await this.page.evaluate((r) => {
            window.location.hash = r;
        }, route);
    }

    /** Force Home to re-read balances by remounting it (hash bounce, no re-boot). */
    async refreshBalances(): Promise<void> {
        await this.goto("receive");
        await expect(this.page.getByText("Share your address")).toBeVisible();
        await this.goto("home");
        await this.waitForReady();
    }

    async openMenu(): Promise<void> {
        await this.menuBtn.click();
    }

    async gotoContacts(): Promise<ContactsPage> {
        await this.openMenu();
        await this.page.getByRole("menuitem", { name: "Contacts" }).click();
        return new ContactsPage(this.page);
    }

    async gotoHistory(): Promise<void> {
        await this.openMenu();
        await this.page.getByRole("menuitem", { name: "Transaction history" }).click();
    }

    /** Add a contact via the menu, then return to Home. */
    async addContact(label: string, address: string): Promise<void> {
        const contacts = await this.gotoContacts();
        await contacts.addContact(label, address);
        await this.page.getByRole("button", { name: "Back" }).click();
        await this.waitForReady();
    }

    /** Import a token by contract address via "+ Import", then return to Home. */
    async importToken(address: string): Promise<void> {
        await this.importBtn.click();
        await new ImportTokenPage(this.page).importByAddress(address);
        await this.page.getByRole("button", { name: "Back to wallet" }).click();
        await this.waitForReady();
    }

    /** Open a token row's "Swap to …" action → the Convert screen. `fromTab` is
     *  the side you're converting OUT of (private → unshield, public → shield). */
    async startConvert(symbol: string, fromTab: Tab): Promise<void> {
        await (fromTab === "private" ? this.privateTab : this.publicTab).click();
        const row = this.page.locator(".token-row", { hasText: symbol });
        await row.getByRole("button", { name: `${symbol} actions` }).click();
        const to = fromTab === "private" ? "public" : "private";
        await this.page.getByRole("menuitem", { name: `Swap to ${to}` }).click();
    }

    // --- Account switcher (multiple HD accounts from one seed) ---

    /** The account rows inside the open Accounts modal (one button per account,
     *  ordered by index). The switch control is a `button.token-meta`. */
    private accountRows(): Locator {
        return this.page.locator(".modal-backdrop button.token-meta");
    }

    private async openAccounts(): Promise<void> {
        await this.accountPill.click();
        await expect(this.accountRows().first()).toBeVisible();
    }

    private async closeAccounts(): Promise<void> {
        await this.page.getByRole("button", { name: "Close" }).click();
    }

    /** Number of accounts currently in the wallet. */
    async accountCount(): Promise<number> {
        await this.openAccounts();
        const n = await this.accountRows().count();
        await this.closeAccounts();
        return n;
    }

    /** Ensure at least `index + 1` accounts exist, deriving more from the seed
     *  ("＋ New account") as needed. (Import may already have discovered some.) */
    async ensureAccount(index: number): Promise<void> {
        await this.openAccounts();
        let count = await this.accountRows().count();
        while (count <= index) {
            await this.page.getByRole("button", { name: /New account/ }).click();
            // The app awaits the derivation, THEN closes the modal — wait for it.
            await expect(this.page.locator(".modal-backdrop")).toBeHidden();
            await this.waitForReady();
            await this.openAccounts();
            count = await this.accountRows().count();
        }
        await this.closeAccounts();
    }

    /** Switch the active account by index (0-based), then wait for the switch to
     *  actually land. The gas line never unmounts on a switch, so it's NOT a
     *  valid signal; the app closes the switcher modal only AFTER the active
     *  account has changed, so wait for the modal to disappear before reading. */
    async switchToAccount(index: number): Promise<void> {
        await this.openAccounts();
        await this.accountRows().nth(index).click();
        await expect(this.page.locator(".modal-backdrop")).toBeHidden();
        await this.waitForReady();
    }

    /** Resolve each address to its HD account index, deriving accounts as needed
     *  (early-stops once all are found). Returns indices in the input order. */
    async resolveAccountIndices(addresses: string[], maxAccounts = 8): Promise<number[]> {
        const want = addresses.map((a) => a.toLowerCase());
        const found = new Map<string, number>();
        for (let i = 0; i < maxAccounts && found.size < want.length; i++) {
            await this.ensureAccount(i);
            await this.switchToAccount(i);
            const addr = (await this.ownAddress()).toLowerCase();
            if (want.includes(addr) && !found.has(addr)) found.set(addr, i);
        }
        return want.map((a) => {
            const idx = found.get(a);
            if (idx === undefined) {
                throw new Error(`account ${a} not found in the first ${maxAccounts} derived accounts`);
            }
            return idx;
        });
    }
}
