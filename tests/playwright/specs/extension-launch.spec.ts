import { test, expect } from "../fixtures";
import { EXTENSION_ID, fatalConsole } from "../constants";

/**
 * The extension actually loads as an unpacked MV3 build and its popup renders.
 * This is the Playwright equivalent of "does the package even boot" — it proves
 * the launch flags, the pinned extension id, and a clean first paint.
 */
test.describe("extension launch", () => {
    test("loads the unpacked MV3 build under the pinned extension id", async ({ popup }) => {
        // chrome.runtime.id is reported from INSIDE the extension page — the
        // ground truth for the id the manifest `key` pins.
        const id = await popup.evaluate(() => chrome.runtime.id);
        expect(id).toMatch(/^[a-p]{32}$/);
        expect(id).toBe(EXTENSION_ID);
    });

    test("popup renders the onboarding screen with no console errors", async ({
        popup,
        consoleErrors,
    }) => {
        await expect(popup.getByRole("button", { name: "Create new wallet" })).toBeVisible();
        await expect(
            popup.getByRole("button", { name: "Import 12-word phrase" }),
        ).toBeVisible();
        await expect(popup.getByText(/Privacy on tap/i)).toBeVisible();
        // CSP / wasm / runtime regressions surface as console errors on boot.
        expect(fatalConsole(consoleErrors), consoleErrors.join("\n")).toEqual([]);
    });
});
