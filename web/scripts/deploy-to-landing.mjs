/**
 * Copies the vite build output into ../landing so Netlify (which serves
 * landing/ with NO build step) can host the app:
 *
 *   dist/bridge/index.html → landing/bridge/index.html
 *   dist/launch/index.html → landing/launch/index.html
 *   dist/<everything else> → landing/webassets/…   (hashed js/css, favicon)
 *
 * Pages reference assets via the absolute /webassets/ base (vite.config.ts),
 * so the same build serves both routes. This script then SANITY-CHECKS the
 * result: expected title text present, and every /webassets/ URL referenced
 * by the HTML/CSS actually exists on disk. Any failure exits non-zero.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");
const dist = path.join(webRoot, "dist");
const landing = path.resolve(webRoot, "..", "landing");

function fail(message) {
    console.error(`✗ ${message}`);
    process.exit(1);
}

for (const required of ["bridge/index.html", "launch/index.html"]) {
    if (!fs.existsSync(path.join(dist, required))) {
        fail(`dist/${required} missing — run \`vite build\` first (yarn build does both).`);
    }
}
if (!fs.existsSync(path.join(landing, "index.html"))) {
    fail(`landing/ not found at ${landing} (expected the repo's static landing page).`);
}

// Wipe ONLY the three generated dirs — never touch landing's own files.
for (const dir of ["bridge", "launch", "webassets"]) {
    fs.rmSync(path.join(landing, dir), { recursive: true, force: true });
    fs.mkdirSync(path.join(landing, dir), { recursive: true });
}

fs.copyFileSync(path.join(dist, "bridge/index.html"), path.join(landing, "bridge/index.html"));
fs.copyFileSync(path.join(dist, "launch/index.html"), path.join(landing, "launch/index.html"));
for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
    if (entry.name === "bridge" || entry.name === "launch") continue;
    fs.cpSync(path.join(dist, entry.name), path.join(landing, "webassets", entry.name), {
        recursive: true,
    });
}

// ── sanity checks on the COMMITTED output ────────────────────────────────────
const WEBASSET_URL = /["'(=]\/webassets\/([^"')?#\s]+)/g;

function checkReferences(relFile, content) {
    let count = 0;
    for (const m of content.matchAll(WEBASSET_URL)) {
        count += 1;
        const assetPath = path.join(landing, "webassets", m[1]);
        if (!fs.existsSync(assetPath)) {
            fail(`${relFile} references missing asset /webassets/${m[1]}`);
        }
    }
    return count;
}

const titleChecks = [
    ["bridge/index.html", "Bridge fee juice"],
    ["launch/index.html", "Launch a token"],
];
for (const [rel, needle] of titleChecks) {
    const html = fs.readFileSync(path.join(landing, rel), "utf8");
    if (!html.includes(needle)) fail(`${rel} does not contain expected title text "${needle}".`);
    const refs = checkReferences(rel, html);
    if (refs === 0) fail(`${rel} references no /webassets/ URLs — base path is broken.`);
    console.log(`✓ landing/${rel}: title ok, ${refs} /webassets/ refs all exist`);
}

const cssDir = path.join(landing, "webassets", "assets");
for (const file of fs.readdirSync(cssDir)) {
    if (!file.endsWith(".css")) continue;
    checkReferences(`webassets/assets/${file}`, fs.readFileSync(path.join(cssDir, file), "utf8"));
}
console.log("✓ css asset references all exist");

// /launch must ship no L1 wallet code (wagmi/RainbowKit are bridge-only).
// Check EVERY js chunk the launch page loads statically (entry + modulepreloads).
const launchHtml = fs.readFileSync(path.join(landing, "launch/index.html"), "utf8");
const launchChunks = [...launchHtml.matchAll(/\/webassets\/(assets\/[^"']+\.js)/g)].map((m) => m[1]);
if (launchChunks.length === 0) fail("launch/index.html references no js chunks.");
for (const chunk of launchChunks) {
    const js = fs.readFileSync(path.join(landing, "webassets", chunk), "utf8").toLowerCase();
    for (const banned of ["walletconnect", "rainbowkit", "wagmi"]) {
        if (js.includes(banned)) {
            fail(`${chunk} (loaded by /launch) contains "${banned}" — wallet code leaked into /launch.`);
        }
    }
}
console.log(`✓ /launch js (${launchChunks.length} chunk${launchChunks.length === 1 ? "" : "s"}) is wallet-free`);

console.log(`✓ deployed: landing/bridge, landing/launch, landing/webassets`);
