/**
 * REAL-CHROME extension smoke test — the publish gate. Opt-in:
 *
 *   BROWSER=1 yarn vitest run --project e2e tests/browser/extension-smoke.test.ts
 *
 * Launches an isolated Chrome with the BUILT extension (dist/) loaded as an
 * unpacked MV3 extension, opens the actual popup page, and walks the critical
 * path in the genuine runtime (MV3 CSP, COOP/COEP, wasm, IndexedDB, WebCrypto):
 *
 *   1. popup renders the onboarding screen with ZERO console errors
 *   2. create a wallet with a passphrase (real Argon2id + AES-GCM + storage)
 *   3. reveal-and-confirm recovery phrase step
 *   4. wallet boots the in-browser PXE against the LOCAL SANDBOX (wasm,
 *      cross-origin isolation, connect-src CSP all proven in one shot)
 *   5. Home renders: address, fee-juice card, Send/Receive controls
 *
 * Requires `aztec start --local-network` running and `yarn build` done.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, globSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { assertSandboxUp } from "../e2e/helpers";

const RUN = !!process.env.BROWSER;
const DIST = join(process.cwd(), "dist");

/**
 * Branded Google Chrome REMOVED --load-extension; only Chrome for Testing (or
 * Chromium) honors it. Install once with:
 *   npx @puppeteer/browsers install chrome@stable
 */
function chromeForTestingPath(): string {
    const home = process.env.HOME!;
    const suffix =
        "chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
    const candidates = [
        ...globSync(`${process.cwd()}/chrome/*/${suffix}`),
        ...globSync(`${home}/.cache/puppeteer/chrome/*/${suffix}`),
    ].sort();
    const found = candidates[candidates.length - 1];
    if (!found) {
        throw new Error(
            "Chrome for Testing not installed. Run: npx @puppeteer/browsers install chrome@stable",
        );
    }
    return found;
}

let browser: Browser;
let popup: Page;
let profileDir: string;
let extensionId: string;
const consoleErrors: string[] = [];

describe.skipIf(!RUN)("extension smoke — real Chrome, built MV3 package", () => {
    beforeAll(async () => {
        await assertSandboxUp();
        if (!existsSync(join(DIST, "manifest.json"))) {
            throw new Error("dist/manifest.json missing — run `yarn build` first.");
        }
        profileDir = mkdtempSync(join(tmpdir(), "aztec-wallet-chrome-"));
        browser = await puppeteer.launch({
            executablePath: chromeForTestingPath(),
            headless: false, // extensions don't load in old headless; new headless is flaky with MV3+wasm threads
            userDataDir: profileDir,
            timeout: 180_000,
            // waitForFunction polls across the PXE's long wasm boot; the
            // default 180s protocol timeout fires first without this.
            protocolTimeout: 420_000,
            // CDP over a pipe: launching headful Chrome for Testing on macOS
            // intermittently never surfaces the WS endpoint on stdout, which
            // times the launcher out. The pipe transport skips that entirely.
            // (It's also REQUIRED for Extensions.loadUnpacked below.)
            pipe: true,
            // Puppeteer injects --disable-extensions by default — strip it so
            // the startup --load-extension below takes effect.
            ignoreDefaultArgs: ["--disable-extensions"],
            args: [
                "--disable-gpu",
                // Chrome 137+ gutted --load-extension EXCEPT when the unsafe
                // extension-debugging flag + pipe transport are both present.
                // Startup-loading (vs CDP Extensions.loadUnpacked) matters: the
                // CDP-injected variant left extension pages unreachable
                // (net::ERR_BLOCKED_BY_CLIENT on direct navigation).
                "--enable-unsafe-extension-debugging",
                `--disable-extensions-except=${DIST}`,
                `--load-extension=${DIST}`,
                "--no-first-run",
                "--no-default-browser-check",
                "--window-size=420,800",
                // Chrome for Testing has no macOS keychain approval; without a
                // mock keychain the headful launch BLOCKS on a keychain prompt
                // and puppeteer times out waiting for the DevTools endpoint.
                "--use-mock-keychain",
                "--password-store=basic",
                // Chrome's Local Network Access gate prompts before letting a
                // page fetch localhost; automated profiles auto-deny, killing
                // the PXE's node connection. Real installs are fine (extensions
                // with matching host_permissions get the LNA carve-out) — this
                // is test-environment-only.
                "--disable-features=LocalNetworkAccessChecks",
            ],
        });

        console.log("[smoke] launched; resolving extension id…");
        // With startup --load-extension the id isn't returned anywhere — read
        // it from extensions-internals (a JSON dump page).
        {
            const internals = await browser.newPage();
            await internals.goto("chrome://extensions-internals/", {
                waitUntil: "domcontentloaded",
                timeout: 60_000,
            });
            const dump = await internals.evaluate(() => document.body.innerText);
            await internals.close();
            const entries = JSON.parse(dump) as Array<{ id: string; name: string }>;
            const ours = entries.find((e) => e.name?.includes("Fizz"));
            if (!ours) {
                throw new Error(
                    `Extension not loaded at startup. Found: ${entries.map((e) => e.name).join(", ")}`,
                );
            }
            extensionId = ours.id;
        }
        console.log(`[smoke] extension id: ${extensionId}`);

        // Give the install a beat to settle before touching extension URLs.
        await new Promise((r) => setTimeout(r, 2_000));

        const popupUrl = `chrome-extension://${extensionId}/src/popup/index.html`;
        popup = await browser.newPage();
        popup.on("console", (msg) => {
            if (msg.type() === "error") consoleErrors.push(msg.text());
        });
        popup.on("pageerror", (err) => consoleErrors.push(String(err)));
        popup.on("requestfailed", (req) => {
            console.log(
                `[smoke] REQUEST FAILED: ${req.method()} ${req.url()} → ${req.failure()?.errorText}`,
            );
        });
        try {
            await popup.goto(popupUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        } catch (err) {
            const targets = browser
                .targets()
                .map((t) => `${t.type()}: ${t.url()}`)
                .join("\n  ");
            console.log(`[smoke] direct goto failed (${err}); targets:\n  ${targets}`);
            // Second attempt after another settle — transient blocks clear once
            // the extensions subsystem finishes registering the unpacked load.
            await new Promise((r) => setTimeout(r, 3_000));
            await popup.goto(popupUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        }
        console.log("[smoke] popup loaded");
    }, 240_000);

    afterAll(async () => {
        await browser?.close();
        if (profileDir) rmSync(profileDir, { recursive: true, force: true });
    });

    async function clickByText(page: Page, text: string, selector = "button") {
        const [el] = await page.$$(`${selector} ::-p-text(${text})`);
        if (!el) throw new Error(`No ${selector} containing "${text}"`);
        await el.click();
    }

    it("renders onboarding with no console errors", async () => {
        await popup.waitForSelector("button ::-p-text(Create new wallet)", { timeout: 30_000 });
        const body = await popup.evaluate(() => document.body.innerText);
        expect(body).toContain("Create new wallet");
        expect(body).toContain("Import 12-word phrase");
        expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
    }, 60_000);

    it("creates a wallet with a passphrase (real vault crypto in-extension)", async () => {
        await clickByText(popup, "Create new wallet");

        // Onboarding auth step: choose the passphrase path. The UI labels vary;
        // find the passphrase inputs generically.
        await popup.waitForSelector("input[type=password]", { timeout: 30_000 });
        const inputs = await popup.$$("input[type=password]");
        expect(inputs.length).toBeGreaterThanOrEqual(1);
        const pass = "vivid-marble-acrobat-cherry-flute-42!";
        for (const input of inputs) await input.type(pass);

        await clickByText(popup, "Continue");

        // Recovery phrase step: capture words, confirm saved.
        await popup.waitForSelector(".mnemonic-word", { timeout: 60_000 });
        const words = await popup.$$eval(".mnemonic-word", (els) =>
            els.map((e) => (e.textContent ?? "").replace(/^\d+\.\s*/, "").trim()),
        );
        expect(words).toHaveLength(12);

        // "I've saved it — create wallet" finalizes vault creation.
        const btns = await popup.$$("button");
        let clicked = false;
        for (const b of btns) {
            const t = (await b.evaluate((e) => e.textContent)) ?? "";
            if (/I've saved it/i.test(t)) {
                await b.click();
                clicked = true;
                break;
            }
        }
        expect(clicked, "finalize-create button not found").toBe(true);
    }, 180_000);

    it("boots the in-browser PXE against the sandbox and reaches Home", async () => {
        // The PXE boot loads wasm + circuit artifacts; allow generous time.
        try {
            await popup.waitForFunction(
                () => {
                    const t = document.body.innerText;
                    return t.includes("Your account") || t.includes("Fee juice");
                },
                { timeout: 300_000, polling: 2_000 },
            );
        } catch (err) {
            const body = await popup.evaluate(() => document.body.innerText);
            console.log(`[smoke] BOOT FAILED — full screen text:\n${body}`);
            console.log(`[smoke] console errors:\n${consoleErrors.join("\n")}`);
            throw err;
        }
        const body = await popup.evaluate(() => document.body.innerText);
        expect(body).toContain("Fee juice");
        expect(body).toMatch(/Send/);
        expect(body).toMatch(/Receive/);

        // CSP/wasm sanity: no console errors accumulated during boot.
        const fatal = consoleErrors.filter(
            (e) =>
                !/favicon|net::ERR_INTERNET_DISCONNECTED|Failed to load resource.*404/i.test(e),
        );
        expect(fatal, fatal.join("\n")).toHaveLength(0);
    }, 360_000);

    it("account address is displayed and copyable", async () => {
        const body = await popup.evaluate(() => document.body.innerText);
        expect(body).toMatch(/0x[0-9a-f]{4,}…?[0-9a-f]{0,8}/i);
    });

    it("deploys a token end-to-end from the UI", async () => {
        // Home → "+ Deploy"
        await clickByText(popup, "+ Deploy");
        await popup.waitForSelector("input[placeholder*='Acme']", { timeout: 30_000 });

        await popup.type("input[placeholder*='Acme']", "Smoke Coin");
        await popup.type("input[placeholder='ACME']", "SMC");

        // Click Deploy and verify the button immediately reflects busy state —
        // a "click does nothing" regression fails here.
        await clickByText(popup, "Deploy token");
        await popup.waitForFunction(
            () => document.body.innerText.includes("Deploying…"),
            { timeout: 10_000, polling: 250 },
        );

        // Account activation (if first tx) + proving + inclusion.
        await popup.waitForFunction(
            () => {
                const t = document.body.innerText;
                return t.includes("Token deployed") || t.toLowerCase().includes("error");
            },
            { timeout: 300_000, polling: 2_000 },
        );
        const body = await popup.evaluate(() => document.body.innerText);
        expect(body).toContain("Token deployed");
        expect(consoleErrors.filter((e) => !/favicon/i.test(e)), consoleErrors.join("\n")).toHaveLength(0);
    }, 360_000);
});
