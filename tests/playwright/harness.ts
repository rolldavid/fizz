import {
    chromium,
    type BrowserContext,
    type Page,
    type Worker,
} from "@playwright/test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    DIST,
    EXTENSION_ID,
    extensionLaunchArgs,
    NEUTRALIZE_DECORATION_CSS,
    popupUrl,
} from "./constants";

/**
 * One running extension instance: a persistent Chromium context with the built
 * unpacked extension loaded, plus its resolved id. Factored out of the
 * Playwright fixtures so the cross-account specs can stand up TWO independent
 * instances (wallet A + wallet B) in the same test.
 */
export type ExtensionInstance = {
    context: BrowserContext;
    extensionId: string;
    /** Open a fresh popup page (optional deep-link hash) with console capture. */
    openPopup(hash?: string): Promise<{ page: Page; consoleErrors: string[] }>;
    /** Close the context and remove its throwaway profile dir. */
    close(): Promise<void>;
};

export async function launchExtension(): Promise<ExtensionInstance> {
    if (!existsSync(join(DIST, "manifest.json"))) {
        throw new Error(
            "dist/manifest.json missing — run `yarn build` before the Playwright e2e suite.",
        );
    }
    const headed = process.env.PW_HEADLESS !== "1";
    const userDataDir = mkdtempSync(join(tmpdir(), "fizz-pw-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: !headed,
        channel: process.env.PW_CHANNEL || undefined,
        executablePath: process.env.PW_EXECUTABLE_PATH || undefined,
        args: extensionLaunchArgs(DIST, headed),
        ignoreDefaultArgs: [
            "--disable-extensions",
            "--disable-component-extensions-with-background-pages",
        ],
        timeout: 180_000,
    });

    let extensionId = EXTENSION_ID;
    let sw: Worker | undefined = context.serviceWorkers()[0];
    if (!sw) {
        sw = await context
            .waitForEvent("serviceworker", { timeout: 8_000 })
            .catch(() => undefined);
    }
    const m = sw && /^chrome-extension:\/\/([a-p]{32})\//.exec(sw.url());
    if (m) extensionId = m[1];

    return {
        context,
        extensionId,
        async openPopup(hash = "") {
            const page = await context.newPage();
            const consoleErrors: string[] = [];
            page.on("console", (msg) => {
                if (msg.type() === "error") consoleErrors.push(msg.text());
            });
            page.on("pageerror", (e) => consoleErrors.push(String(e)));
            await page.goto(popupUrl(extensionId, hash), { waitUntil: "domcontentloaded" });
            await page.addStyleTag({ content: NEUTRALIZE_DECORATION_CSS });
            return { page, consoleErrors };
        },
        async close() {
            await context.close();
            rmSync(userDataDir, { recursive: true, force: true });
        },
    };
}
