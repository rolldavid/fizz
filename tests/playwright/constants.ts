import { join } from "node:path";

/**
 * Shared constants + launch config for the Playwright extension suite.
 */

/** Repo-root dist/ — the BUILT unpacked MV3 extension. Playwright runs from the
 *  repo root, so cwd is the repo root (mirrors tests/browser/extension-smoke). */
export const DIST = join(process.cwd(), "dist");

/** The published extension id, pinned by the manifest `key` (src/manifest.ts).
 *  Loading the unpacked dist/ yields THIS id on every machine, so the popup URL
 *  is stable. The launch spec re-derives it from inside the extension
 *  (chrome.runtime.id) and asserts it matches — if the manifest key ever
 *  changes, that test fails loudly. */
export const EXTENSION_ID = "kadklgafmpoomnhnbjkeajapglmmegfj";

/** URL of the popup page, optionally with a deep-link hash (#send, #receive…). */
export const popupUrl = (extensionId: string, hash = ""): string =>
    `chrome-extension://${extensionId}/src/popup/index.html${hash}`;

/** A passphrase that clears the onboarding strength meter (score ok + length). */
export const TEST_PASSPHRASE = "vivid-marble-acrobat-cherry-flute-42!";

/** Display names for the network ids (the header picker shows the name, the
 *  config uses the id). Mirrors src/lib/aztec/networks.ts. */
export const NETWORK_NAMES: Record<string, string> = {
    alpha: "Aztec Mainnet",
    testnet: "Aztec Testnet",
    devnet: "Aztec Devnet",
    sandbox: "Local sandbox",
};

/** Canonical valid 12-word BIP39 mnemonic (the Hardhat/Anvil default) for the
 *  import-flow tests. Passes isValidMnemonic; never holds real funds. */
export const TEST_MNEMONIC =
    "test test test test test test test test test test test junk";

/**
 * Chrome launch flags for loading the unpacked MV3 extension. Distilled from the
 * hard-won set in tests/browser/extension-smoke.test.ts (Puppeteer):
 *   - --enable-unsafe-extension-debugging: Chrome 137+ gutted --load-extension
 *     unless this is present (Playwright already drives Chromium over a CDP pipe,
 *     the other half of that gate). Harmlessly ignored by older Chromium.
 *   - --use-mock-keychain / --password-store=basic: skip the macOS keychain
 *     prompt that otherwise BLOCKS a headful launch.
 *   - --disable-features=LocalNetworkAccessChecks: let the in-popup PXE reach a
 *     localhost sandbox node (test-env only; real installs get the carve-out via
 *     host_permissions).
 */
export function extensionLaunchArgs(dist: string, headed: boolean): string[] {
    return [
        "--disable-gpu",
        "--enable-unsafe-extension-debugging",
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--use-mock-keychain",
        "--password-store=basic",
        "--disable-features=LocalNetworkAccessChecks",
        ...(headed ? ["--window-size=440,860"] : []),
    ];
}

/**
 * CSS injected into every popup page. The decorative `.fizz-bubbles` float
 * around behind the UI and, being real positioned elements, intermittently sit
 * over a button/input's hit-test point — making click/press flakily time out on
 * the intro and lock screens. They're purely cosmetic (aria-hidden), so neutralize
 * them in tests. Allowed by the extension CSP (style-src 'self' 'unsafe-inline').
 */
export const NEUTRALIZE_DECORATION_CSS =
    ".fizz-bubbles{display:none!important;pointer-events:none!important}";

/** Console noise that isn't a real failure (favicon, 404s, transient offline). */
const BENIGN_CONSOLE = /favicon|net::ERR_INTERNET_DISCONNECTED|Failed to load resource.*40\d/i;

/** Filter a captured console-error list down to genuine failures. */
export const fatalConsole = (errors: string[]): string[] =>
    errors.filter((e) => !BENIGN_CONSOLE.test(e));
