/**
 * DIAGNOSTIC — not a test. Reproduces the live-user deploy hang + bridge
 * spinner against TESTNET in real Chrome, with full instrumentation:
 *
 *   - network capture of the CRS CDN / L1 RPC / node RPC (timing + bytes)
 *   - page + worker console, uncaught errors, unhandled promise rejections
 *   - mouse jiggle every sample so the 5-min idle auto-lock CANNOT fire
 *     (isolates "deploy is slow" from "auto-lock killed it")
 *
 * Usage:  node scripts/diagnose-deploy.mjs
 * Loads a COPY of dist/ so rebuilds during the run don't corrupt the session.
 */
import { cpSync, existsSync, globSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[${el()}]`, ...a);

function chromeForTestingPath() {
    const home = process.env.HOME;
    const suffix =
        "chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
    const candidates = [
        ...globSync(`${process.cwd()}/chrome/*/${suffix}`),
        ...globSync(`${home}/.cache/puppeteer/chrome/*/${suffix}`),
    ].sort();
    const found = candidates[candidates.length - 1];
    if (!found) throw new Error("Chrome for Testing not installed.");
    return found;
}

const SRC_DIST = join(process.cwd(), "dist");
if (!existsSync(join(SRC_DIST, "manifest.json"))) throw new Error("run `yarn build` first");
const DIST = mkdtempSync(join(tmpdir(), "fizz-dist-diag-"));
cpSync(SRC_DIST, DIST, { recursive: true });
const profileDir = mkdtempSync(join(tmpdir(), "fizz-diag-profile-"));

const browser = await puppeteer.launch({
    executablePath: chromeForTestingPath(),
    headless: false,
    userDataDir: profileDir,
    timeout: 180_000,
    protocolTimeout: 900_000,
    pipe: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
        "--disable-gpu",
        "--enable-unsafe-extension-debugging",
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=420,800",
        "--use-mock-keychain",
        "--password-store=basic",
        "--disable-features=LocalNetworkAccessChecks",
    ],
});
log("launched");

const internals = await browser.newPage();
await internals.goto("chrome://extensions-internals/", { waitUntil: "domcontentloaded" });
const entries = JSON.parse(await internals.evaluate(() => document.body.innerText));
await internals.close();
const extensionId = entries.find((e) => e.name?.includes("Fizz"))?.id;
if (!extensionId) throw new Error("extension not loaded");
log("extension id:", extensionId);
await new Promise((r) => setTimeout(r, 2000));

const popup = await browser.newPage();

// ── instrumentation ──────────────────────────────────────────────────────────
await popup.evaluateOnNewDocument(() => {
    window.addEventListener("unhandledrejection", (e) => {
        // Surfaces promise chains that die silently (e.g. refresh() in Bridge).
        console.error(`[DIAG-UNHANDLED-REJECTION] ${e.reason?.stack ?? e.reason}`);
    });
});
const consoleLines = [];
popup.on("console", (msg) => {
    const line = `[${el()}][${msg.type()}] ${msg.text().slice(0, 300)}`;
    consoleLines.push(line);
    if (msg.type() === "error" || msg.type() === "warn" || /DIAG/.test(msg.text()))
        console.log("  CONSOLE>", line);
});
popup.on("pageerror", (err) => console.log(`  PAGEERROR> [${el()}]`, String(err).slice(0, 400)));
popup.on("workercreated", (w) => {
    log("WORKER CREATED:", w.url().slice(-80));
});
const watched = /crs\.aztec-cdn|publicnode|aztec-labs/;
const reqStart = new Map();
popup.on("request", (req) => {
    if (!watched.test(req.url())) return;
    reqStart.set(req.url() + "#" + (reqStart.size), Date.now());
    if (/crs/.test(req.url()))
        log(`NET→ ${req.method()} ${req.url().slice(-40)} range=${req.headers().range ?? "-"}`);
});
popup.on("requestfinished", async (req) => {
    if (!watched.test(req.url())) return;
    const res = req.response();
    const len = res?.headers()["content-length"] ?? "?";
    const range = res?.headers()["content-range"] ?? "";
    if (/crs/.test(req.url())) {
        log(`NET✓ ${res?.status()} ${req.url().slice(-40)} len=${len} ${range}`);
    }
});
popup.on("requestfailed", (req) => {
    if (!watched.test(req.url())) return;
    log(`NET✗ FAILED ${req.url().slice(-60)} → ${req.failure()?.errorText}`);
});

// Count RPC chatter without logging each (testnet node polls constantly).
let rpcCounts = { publicnode: 0, node: 0 };
popup.on("response", (res) => {
    if (/publicnode/.test(res.url())) rpcCounts.publicnode++;
    if (/aztec-labs/.test(res.url())) rpcCounts.node++;
});

await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
});
log("popup loaded");

// Any failure below: dump what the screen actually showed before dying.
process.on("uncaughtException", async (err) => {
    console.log("FATAL:", err.message);
    try {
        const t = await popup.evaluate(() => document.body.innerText);
        console.log("screen at failure:", JSON.stringify(t.slice(0, 600)));
        await popup.screenshot({ path: "/tmp/diag-fail.png" });
        console.log("screenshot: /tmp/diag-fail.png");
        console.log("last console lines:");
        for (const l of consoleLines.slice(-15)) console.log("   ", l);
    } catch {}
    await browser.close().catch(() => {});
    process.exit(1);
});

async function clickByText(text, selector = "button") {
    const [elh] = await popup.$$(`${selector} ::-p-text(${text})`);
    if (!elh) throw new Error(`No ${selector} containing "${text}"`);
    await elh.click();
}
const bodyText = () => popup.evaluate(() => document.body.innerText);

// ── create wallet ────────────────────────────────────────────────────────────
await popup.waitForSelector("button ::-p-text(Create new wallet)", { timeout: 30_000 });
await clickByText("Create new wallet");
await popup.waitForSelector("input[type=password]", { timeout: 30_000 });
for (const input of await popup.$$("input[type=password]"))
    await input.type("vivid-marble-acrobat-cherry-flute-42!");
// The Continue button is gated on the strength meter — wait until enabled,
// otherwise the click lands on a disabled button and silently does nothing.
await popup.waitForFunction(
    () =>
        [...document.querySelectorAll("button")].some(
            (b) => b.textContent?.includes("Continue") && !b.disabled,
        ),
    { timeout: 10_000, polling: 250 },
);
await clickByText("Continue");
await popup.waitForSelector(".mnemonic-word", { timeout: 60_000 });
for (const b of await popup.$$("button")) {
    const t = (await b.evaluate((e) => e.textContent)) ?? "";
    if (/I've saved it/i.test(t)) {
        await b.click();
        break;
    }
}
log("wallet created; waiting for Home (testnet PXE boot)…");

await popup.waitForFunction(
    () => {
        const t = document.body.innerText;
        return t.includes("Fee juice") || t.includes("Your account");
    },
    { timeout: 360_000, polling: 2_000 },
);
log(`HOME reached. rpc so far: node=${rpcCounts.node} publicnode=${rpcCounts.publicnode}`);

// ── bridge page: reproduce the funding-card spinner ─────────────────────────
log("opening Bridge…");
await clickByText("Bridge");
for (const wait of [5, 15, 30]) {
    await new Promise((r) => setTimeout(r, wait * 1000 - (wait > 5 ? 0 : 0)));
    const t = await bodyText();
    const hasSpinner = await popup.$(".spinner");
    const state = t.includes("funding address")
        ? `card-present spinner=${!!hasSpinner} ethShown=${/ETH/.test(t)} err=${/error|Error/.test(t)}`
        : "no funding card text";
    log(`BRIDGE @+${wait}s: ${state} publicnodeReqs=${rpcCounts.publicnode}`);
    if (!hasSpinner) break;
}
{
    const t = await bodyText();
    log("BRIDGE screen head:", JSON.stringify(t.slice(0, 400)));
}
await clickByText("← Back");
await new Promise((r) => setTimeout(r, 1000));

// ── deploy: watch it to completion with idle-lock defeated ───────────────────
log("starting token deploy…");
await clickByText("+ Deploy");
await popup.waitForSelector("input[placeholder*='Acme']", { timeout: 30_000 });
await popup.type("input[placeholder*='Acme']", "Diag Coin");
await popup.type("input[placeholder='ACME']", "DIAG");
await clickByText("Deploy token");
const deployStart = Date.now();
log("deploy clicked");

let verdict = "TIMEOUT (20 min)";
for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    // jiggle: real input events → resets the idle-lock timer
    await popup.mouse.move(50 + (i % 7) * 10, 700 - (i % 5) * 10);
    const t = await bodyText();
    const dt = ((Date.now() - deployStart) / 1000).toFixed(0);
    if (i % 3 === 0)
        log(
            `DEPLOY +${dt}s: busy=${t.includes("Deploying…")} screen="${t.replace(/\n+/g, " | ").slice(0, 120)}" rpc node=${rpcCounts.node}`,
        );
    if (t.includes("Locked tight")) {
        verdict = `AUTO-LOCKED at +${dt}s despite jiggle`;
        break;
    }
    if (t.includes("Token deployed")) {
        verdict = `SUCCESS at +${dt}s`;
        break;
    }
    const errLine = t.split("\n").find((l) => /error|failed|reverted/i.test(l));
    if (errLine && !t.includes("Deploying…")) {
        verdict = `ERROR at +${dt}s: ${errLine.slice(0, 300)}`;
        break;
    }
}

log("VERDICT:", verdict);
log("last console lines:");
for (const l of consoleLines.slice(-25)) console.log("   ", l);
log(`rpc totals: node=${rpcCounts.node} publicnode=${rpcCounts.publicnode}`);

await browser.close();
rmSync(profileDir, { recursive: true, force: true });
rmSync(DIST, { recursive: true, force: true });
process.exit(0);
