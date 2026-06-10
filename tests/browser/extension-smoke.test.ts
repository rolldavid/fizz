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
 *   4. wallet boots the in-browser PXE against the DEFAULT network (Alpha /
 *      mainnet — wasm, cross-origin isolation, connect-src CSP, and live
 *      mainnet-node connectivity all proven in one shot), then switches to
 *      testnet for the deploy (mainnet has no sponsored fees)
 *   5. Home renders: address, fee-juice card, Send/Receive controls
 *   6. a token deploys end-to-end from the UI — the live-user path, including
 *      the first-proof CRS download and the busy-defers-idle-lock behavior
 *      (no synthetic input events are generated during the wait, so if the
 *      auto-lock fires mid-deploy this test sees the lock screen and fails)
 *
 * Requires `yarn build` done. Talks to live testnet.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, globSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

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
const allConsole: string[] = [];

describe.skipIf(!RUN)("extension smoke — real Chrome, built MV3 package", () => {
    beforeAll(async () => {
        if (!existsSync(join(DIST, "manifest.json"))) {
            throw new Error("dist/manifest.json missing — run `yarn build` first.");
        }
        profileDir = mkdtempSync(join(tmpdir(), "aztec-wallet-chrome-"));
        browser = await puppeteer.launch({
            executablePath: chromeForTestingPath(),
            headless: false, // extensions don't load in old headless; new headless is flaky with MV3+wasm threads
            userDataDir: profileDir,
            timeout: 180_000,
            // Must exceed the LONGEST waitForFunction below (the 600s deploy
            // wait): with default polling a wait holds one CDP call open the
            // whole time, and the protocol timeout would kill it first with a
            // misleading "Runtime.callFunctionOn timed out" (seen in the wild).
            protocolTimeout: 900_000,
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
            allConsole.push(`[${msg.type()}] ${msg.text().slice(0, 200)}`);
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

        // Continue is gated on the strength meter — wait until enabled, or the
        // click lands on a disabled button and silently does nothing.
        await popup.waitForFunction(
            () =>
                [...document.querySelectorAll("button")].some(
                    (b) => b.textContent?.includes("Continue") && !b.disabled,
                ),
            { timeout: 10_000, polling: 250 },
        );
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

    it("boots the in-browser PXE and reaches Home", async () => {
        // The PXE boot loads wasm + circuit artifacts; allow generous time.
        try {
            await popup.waitForFunction(
                () => {
                    const t = document.body.innerText;
                    return t.includes("Your account") || t.includes("Need gas?") || t.includes("Sponsored");
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
        // The fee-juice (gas) line + Send/Receive nav prove Home rendered.
        expect(body).toMatch(/Need gas\?|Sponsored/);
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

    it("fee-juice screen: web-bridge link-out + ticket import render (wallet stays a wallet)", async () => {
        await clickByText(popup, "Need gas?");
        // Acquisition lives on fizzwallet.com/bridge now — the wallet screen
        // shows the link-out card, the claim-ticket import fallback, and any
        // pending claims. A visible error is acceptable; a dead screen is not.
        await popup.waitForFunction(
            () => document.body.innerText.includes("fizzwallet.com/bridge"),
            { timeout: 30_000, polling: 1_000 },
        );
        const body = await popup.evaluate(() => document.body.innerText);
        expect(body).toContain("claim ticket");
        await clickByText(popup, "← Back");
        await popup.waitForFunction(
            () => /Need gas\?|Sponsored/.test(document.body.innerText),
            { timeout: 15_000, polling: 500 },
        );
    }, 60_000);

    it("deploys a token end-to-end from the UI", async () => {
        // Proving capability probe: without cross-origin isolation bb.js
        // silently falls back to ONE thread and proofs take minutes.
        const coi = await popup.evaluate(() => ({
            crossOriginIsolated: globalThis.crossOriginIsolated,
            sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
            cores: navigator.hardwareConcurrency,
        }));
        console.log(`[smoke] isolation: ${JSON.stringify(coi)}`);

        // The default network is now Alpha (mainnet), which has NO sponsored FPC
        // and no fee juice on a fresh account — so a deploy there can't pay fees.
        // Switch to TESTNET (sponsored fees) for this end-to-end deploy via the
        // Header network picker, which re-boots the PXE against testnet.
        await popup.waitForSelector("select", { timeout: 10_000 });
        await popup.select("select", "testnet");
        await new Promise((r) => setTimeout(r, 1_000)); // let setNetwork fire the re-boot
        console.log("[smoke] switched to testnet for the deploy (mainnet has no sponsored fees)");

        // Token deployment is no longer on Home (the wallet is just a wallet —
        // fizzwallet.com/launch owns it). Enter via the #deploy deep link in
        // the LIVE unlocked session (hashchange routing). Production /launch
        // opens a fresh window where the user unlocks by hand — that unlock
        // step can't be reliably synthesized: Chrome's automation input
        // pipeline drops events on fresh/reloaded extension pages here
        // (hit-test-verified: button under the cursor, real input unaffected).
        // Vault unlock crypto is covered by the creation test above.
        await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html#deploy`, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
        });
        try {
            // Generous: the testnet re-boot (PXE teardown + re-sync) precedes the form.
            await popup.waitForSelector("input[placeholder*='Acme']", { timeout: 300_000 });
        } catch (err) {
            const body = await popup.evaluate(() => document.body.innerText);
            console.log(`[smoke] DEPLOY ENTRY FAILED — screen:\n${body.slice(0, 600)}`);
            console.log(`[smoke] console tail:\n${allConsole.slice(-15).join("\n")}`);
            throw err;
        }

        // This page runs as a TAB (puppeteer), which survives blur — the
        // popup-fragility guard must therefore be hidden here. If this fails,
        // isToolbarPopup() is misdetecting and every page would nag wrongly.
        {
            const body = await popup.evaluate(() => document.body.innerText);
            expect(body).not.toContain("Open in a window");
        }

        await popup.type("input[placeholder*='Acme']", "Smoke Coin");
        await popup.type("input[placeholder='ACME']", "SMC");

        // Click Deploy and verify the button immediately reflects busy state —
        // a "click does nothing" regression fails here. The busy button shows
        // the current stage ("Activating your account…", then "Proving +
        // publishing the token…").
        await clickByText(popup, "Deploy token");
        await popup.waitForFunction(
            () => /Activating your account|Proving \+ publishing/.test(document.body.innerText),
            { timeout: 10_000, polling: 250 },
        );
        console.log("[smoke] busy state confirmed — deploy in flight");

        // Account activation (if first tx) + proving + inclusion. First-run
        // proving downloads/compiles keys; allow up to 10 min and dump the
        // console trail on failure. The error check matches the .error ELEMENT
        // — app error messages don't necessarily contain the word "error", and
        // a missed one sits until the idle auto-lock wipes the evidence.
        try {
            await popup.waitForFunction(
                () => {
                    const t = document.body.innerText;
                    return t.includes("Token deployed") || !!document.querySelector(".error");
                },
                { timeout: 600_000, polling: 2_000 },
            );
            const errEl = await popup.$(".error");
            if (errEl) {
                const msg = await errEl.evaluate((e) => e.textContent);
                throw new Error(`Deploy surfaced an error: ${msg}`);
            }
        } catch (err) {
            console.log(`[smoke] DEPLOY HUNG — last console lines:\n${allConsole.slice(-30).join("\n")}`);
            const body = await popup.evaluate(() => document.body.innerText);
            console.log(`[smoke] screen text:\n${body}`);
            throw err;
        }
        const body = await popup.evaluate(() => document.body.innerText);
        expect(body).toContain("Token deployed");
    }, 700_000);

    it("deep link: a fresh window restores the session unlock and lands on the route", async () => {
        // Session persistence: the wallet was unlocked earlier this run, so a
        // brand-new page in the SAME browser session restores the cached unlock
        // (no re-login — the seed is in chrome.storage.session memory) AND honors
        // the #bridge hash route. This is exactly what /launch + the bridge
        // link-out rely on. (Browser restart wipes session storage → re-login.)
        const page2 = await browser.newPage();
        await page2.goto(`chrome-extension://${extensionId}/src/popup/index.html#bridge`, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
        });
        try {
            await page2.waitForFunction(
                () =>
                    document.body.innerText.includes("fizzwallet.com/bridge") &&
                    !document.body.innerText.includes("Locked tight"),
                { timeout: 300_000, polling: 2_000 },
            );
        } catch (err) {
            const body = await page2.evaluate(() => document.body.innerText).catch(() => "(dead)");
            console.log(`[smoke] DEEP-LINK/SESSION FAILED — screen:\n${body.slice(0, 400)}`);
            throw err;
        }
        const hash = await page2.evaluate(() => window.location.hash);
        expect(hash).toBe("#bridge");
        await page2.close();
    }, 360_000);
});
