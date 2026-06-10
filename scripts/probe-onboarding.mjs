/** Micro-probe: where exactly does wallet creation wedge? Step-by-step with
 *  short timeouts, screen snapshots, and an evaluate-based click fallback. */
import { globSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const chrome = globSync(
    `${process.cwd()}/chrome/*/chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
).sort().pop();

const DIST = mkdtempSync(join(tmpdir(), "fizz-probe-dist-"));
cpSync(join(process.cwd(), "dist"), DIST, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "fizz-probe-profile-"));

const browser = await puppeteer.launch({
    executablePath: chrome, headless: false, userDataDir: profile,
    timeout: 120_000, protocolTimeout: 60_000, pipe: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--disable-gpu", "--enable-unsafe-extension-debugging",
        `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`,
        "--no-first-run", "--no-default-browser-check", "--window-size=420,800",
        "--use-mock-keychain", "--password-store=basic",
        "--disable-features=LocalNetworkAccessChecks"],
});
log("launched");
const internals = await browser.newPage();
await internals.goto("chrome://extensions-internals/", { waitUntil: "domcontentloaded" });
const id = JSON.parse(await internals.evaluate(() => document.body.innerText))
    .find((e) => e.name?.includes("Fizz"))?.id;
await internals.close();
log("ext id", id);

const popup = await browser.newPage();
popup.on("console", (m) => log(`  console[${m.type()}]`, m.text().slice(0, 160)));
popup.on("pageerror", (e) => log("  PAGEERROR", String(e).slice(0, 200)));
await popup.goto(`chrome-extension://${id}/src/popup/index.html`, { waitUntil: "domcontentloaded" });
log("popup loaded");

await popup.waitForSelector("button ::-p-text(Create new wallet)", { timeout: 20_000 });
log("create button present");

// Lifecycle forensics: input-level mouse events + screenshots stall when the
// page never reaches a stable paint — find what's still pending.
const lifecycle = await popup.evaluate(() => {
    const res = performance.getEntriesByType("resource");
    const pending = res.filter((r) => r.responseEnd === 0).map((r) => r.name.split("/").pop());
    return {
        readyState: document.readyState,
        resources: res.length,
        pending: pending.slice(0, 10),
        fonts: document.fonts?.status,
        animations: document.getAnimations?.().length,
    };
});
log("lifecycle:", JSON.stringify(lifecycle));

// Step A: puppeteer click with its own watchdog
const clickP = (async () => {
    const [el] = await popup.$$("button ::-p-text(Create new wallet)");
    await el.click();
    return "puppeteer-click-ok";
})();
const a = await Promise.race([clickP, new Promise((r) => setTimeout(() => r("CLICK-HUNG"), 15_000))]);
log("step A:", a);

if (a === "CLICK-HUNG") {
    log("falling back to evaluate-click");
    await popup.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
            b.textContent?.includes("Create new wallet"));
        btn?.click();
    });
}

await new Promise((r) => setTimeout(r, 3_000));
const text1 = await popup.evaluate(() => document.body.innerText);
log("screen after click:", JSON.stringify(text1.slice(0, 200)));
const pw = await popup.$$("input[type=password]");
log("password inputs:", pw.length);

if (pw.length) {
    const typeP = (async () => {
        for (const i of pw) await i.type("vivid-marble-acrobat-cherry-flute-42!");
        return "typed-ok";
    })();
    const b = await Promise.race([typeP, new Promise((r) => setTimeout(() => r("TYPE-HUNG"), 30_000))]);
    log("step B:", b);
    const text2 = await popup.evaluate(() => document.body.innerText);
    log("screen after type:", JSON.stringify(text2.slice(0, 150)));
    const contP = (async () => {
        await popup.waitForFunction(
            () => [...document.querySelectorAll("button")].some(
                (x) => x.textContent?.includes("Continue") && !x.disabled),
            { timeout: 15_000, polling: 500 });
        const [c] = await popup.$$("button ::-p-text(Continue)");
        await c.click();
        return "continue-ok";
    })();
    const c = await Promise.race([contP, new Promise((r) => setTimeout(() => r("CONTINUE-HUNG"), 25_000))]);
    log("step C:", c);
    await new Promise((r) => setTimeout(r, 4_000));
    const words = await popup.$$(".mnemonic-word");
    log("mnemonic words:", words.length);
}

// ── continue to Home, then reproduce the deep-link unlock no-op ──────────────
for (const b of await popup.$$("button")) {
    const t = (await b.evaluate((e) => e.textContent)) ?? "";
    if (/I've saved it/i.test(t)) {
        await b.click();
        break;
    }
}
log("creating vault → waiting for Home…");
await popup.waitForFunction(
    () => document.body.innerText.includes("Fee juice"),
    { timeout: 300_000, polling: 2_000 },
);
log("HOME reached — now goto #deploy + reload (the /launch entry path)");
await popup.goto(popup.url().split("#")[0] + "#deploy", { waitUntil: "domcontentloaded" });
await popup.reload({ waitUntil: "domcontentloaded" });
await popup.waitForSelector("input[type=password]", { timeout: 30_000 });
log("unlock screen up; typing passphrase…");
await popup.type("input[type=password]", "vivid-marble-acrobat-cherry-flute-42!");
const state1 = await popup.evaluate(() => {
    const input = document.querySelector("input[type=password]");
    const btn = [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.trim() === "Unlock");
    return { value: input?.value ?? null, valueLen: input?.value?.length ?? 0,
             btnFound: !!btn, btnDisabled: btn?.disabled ?? null };
});
log("after type:", JSON.stringify(state1));
const clickU = (async () => {
    const [b] = await popup.$$("button ::-p-text(Unlock)");
    await b.click();
    return "unlock-click-ok";
})();
log("step U:", await Promise.race([clickU, new Promise((r) => setTimeout(() => r("UNLOCK-CLICK-HUNG"), 15_000))]));
await new Promise((r) => setTimeout(r, 3_000));
const after1 = await popup.evaluate(() => document.body.innerText.slice(0, 60));
log("screen +3s:", JSON.stringify(after1));

if (/Locked tight/.test(after1)) {
    // Forensics: what does the browser think is at the button's center?
    const hit = await popup.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find(
            (b) => b.textContent?.trim() === "Unlock",
        );
        const r = btn.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const stack = document.elementsFromPoint(cx, cy).map(
            (e) => `${e.tagName}.${(e.className || "").toString().slice(0, 30)}`,
        );
        return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, cx, cy, stack,
                 innerW: window.innerWidth, innerH: window.innerHeight,
                 scrollY: window.scrollY, dpr: window.devicePixelRatio };
    });
    log("hit-test:", JSON.stringify(hit));
    // Coordinate-level mouse click (bypasses puppeteer's quad math).
    await popup.mouse.click(hit.cx, hit.cy);
    await new Promise((r) => setTimeout(r, 4_000));
    log("after mouse.click:", JSON.stringify(await popup.evaluate(() => document.body.innerText.slice(0, 60))));
    // And a keyboard path: focus input + Enter (Unlock submits on Enter).
    await popup.focus("input[type=password]");
    await popup.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, 6_000));
    log("after Enter:", JSON.stringify(await popup.evaluate(() => document.body.innerText.slice(0, 80))));
}
await browser.close();
rmSync(profile, { recursive: true, force: true });
rmSync(DIST, { recursive: true, force: true });
