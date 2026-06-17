import { test as base, type BrowserContext, type Page } from "@playwright/test";
import { launchExtension, type ExtensionInstance } from "./harness";
import { NEUTRALIZE_DECORATION_CSS, popupUrl } from "./constants";

type Fixtures = {
    /** The running extension instance (persistent context + resolved id). One
     *  fresh, isolated profile per test, so every test starts from the
     *  `uninitialized` (onboarding) state. */
    extension: ExtensionInstance;
    /** Convenience: the extension's BrowserContext. */
    context: BrowserContext;
    /** The loaded extension's id (service-worker-derived; pinned-key fallback). */
    extensionId: string;
    /** Console-error sink shared with `popup` (assert it stayed empty — a CSP /
     *  wasm / runtime regression shows up here). */
    consoleErrors: string[];
    /** A page already opened on the popup root (onboarding for a fresh profile),
     *  with console + pageerror capture wired into `consoleErrors`. */
    popup: Page;
};

export const test = base.extend<Fixtures>({
    extension: async ({}, use) => {
        const ext = await launchExtension();
        await use(ext);
        await ext.close();
    },

    context: async ({ extension }, use) => {
        await use(extension.context);
    },

    extensionId: async ({ extension }, use) => {
        await use(extension.extensionId);
    },

    consoleErrors: async ({}, use) => {
        await use([]);
    },

    popup: async ({ extension, consoleErrors }, use) => {
        const page = await extension.context.newPage();
        page.on("console", (m) => {
            if (m.type() === "error") consoleErrors.push(m.text());
        });
        page.on("pageerror", (e) => consoleErrors.push(String(e)));
        await page.goto(popupUrl(extension.extensionId), { waitUntil: "domcontentloaded" });
        await page.addStyleTag({ content: NEUTRALIZE_DECORATION_CSS });
        await use(page);
    },
});

export const expect = test.expect;
