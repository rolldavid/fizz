/**
 * Toolbar-popup lifecycle escape hatch.
 *
 * Chrome destroys a toolbar (action) popup the instant it loses focus — no
 * event, no prompt. For this wallet that kills the in-page PXE, the proving
 * workers, and any in-flight transaction: a token deploy proves for ~3 minutes,
 * and one glance at another window silently cancels it. The user reads that as
 * "nothing happened".
 *
 * The fix is to run long work in a context Chrome doesn't kill on blur: a
 * standalone extension window (same page, `type: "popup"` window) or a full
 * tab. `chrome.tabs.getCurrent()` distinguishes the contexts: it resolves to a
 * Tab in tabs and app windows, and to undefined inside a toolbar popup.
 */

const ROUTES = [
    "home",
    "send",
    "receive",
    "bridge",
    "deploy",
    "mint",
    "contacts",
    "reveal",
    "connect",
] as const;
export type AppRoute = (typeof ROUTES)[number];

/** Parse a deep-link hash ("#deploy") to a known route; anything else → home. */
export function routeFromHash(hash: string): AppRoute {
    const candidate = hash.replace(/^#/, "");
    return (ROUTES as readonly string[]).includes(candidate) ? (candidate as AppRoute) : "home";
}

/**
 * True only inside the toolbar popup (the blur-fragile context). Outside an
 * extension (unit tests) there is no toolbar popup to be in.
 */
export async function isToolbarPopup(): Promise<boolean> {
    const tabs = (globalThis as any).chrome?.tabs;
    if (typeof tabs?.getCurrent !== "function") return false;
    const tab = await tabs.getCurrent();
    return tab == null;
}

/**
 * Re-open the app at `route` in a standalone window that survives focus loss,
 * then close the popup. Falls back to a regular tab if windows are unavailable.
 */
export async function openStandaloneWindow(route: AppRoute): Promise<void> {
    const chromeApi = (globalThis as any).chrome;
    const url = chromeApi.runtime.getURL(`src/popup/index.html#${route}`);
    if (chromeApi.windows?.create) {
        await chromeApi.windows.create({ url, type: "popup", width: 420, height: 820 });
    } else {
        await chromeApi.tabs.create({ url });
    }
    window.close();
}
