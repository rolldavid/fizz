import { defineConfig } from "@playwright/test";

/**
 * Playwright E2E for the BUILT Chrome MV3 extension (dist/).
 *
 * The extension is loaded as an UNPACKED extension into a persistent Chromium
 * context — MV3 extensions cannot load into Playwright's default ephemeral
 * contexts. The launch flags + service-worker id detection live in
 * tests/playwright/fixtures.ts (distilled from the Puppeteer smoke test).
 *
 * Prerequisite: `yarn build` (the suite asserts dist/manifest.json exists and
 * fails fast with a clear message otherwise).
 *
 * Tiers:
 *   - default      onboarding / unlock / launch flows. Fully LOCAL — the vault
 *                  crypto runs in-extension and no Aztec node is contacted, so
 *                  these are deterministic and fast.
 *   - PW_NETWORK=1 boots the in-browser PXE against a LIVE Aztec node (wasm
 *                  proving + node connectivity). Slow + environment-dependent;
 *                  off by default, mirroring the `BROWSER=1` Puppeteer gate.
 *
 * Env knobs (see tests/playwright/constants.ts):
 *   - PW_HEADLESS=1          run headless (new headless). Default is HEADED,
 *                            the most reliable mode for MV3 + wasm threads.
 *   - PW_CHANNEL=chrome      use a branded channel instead of bundled Chromium.
 *   - PW_EXECUTABLE_PATH=…   point at a specific Chromium / Chrome-for-Testing.
 *   - PW_NETWORK=1           enable the live-network tier.
 */
export default defineConfig({
    testDir: "./tests/playwright",
    // Each test gets its own freshly-profiled extension instance, but they share
    // one heavyweight artifact (a full Chromium + wasm-capable popup) and the
    // network tier must stay serial — so run one at a time and predictably.
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    // One retry even locally: Chrome occasionally drops a synthesized input
    // event on a fresh extension-popup page (documented in the Puppeteer smoke).
    retries: process.env.CI ? 2 : 1,
    // Generous per-test budget for vault crypto (Argon2id) + page boot; the
    // network tier raises its own timeout further.
    timeout: 120_000,
    expect: { timeout: 15_000 },
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        actionTimeout: 15_000,
        navigationTimeout: 30_000,
        trace: "on-first-retry",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
    },
});
