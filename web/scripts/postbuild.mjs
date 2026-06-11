/**
 * Post-build for the fizzwallet.com SPA.
 *
 *  1. Emits per-route HTML shells (dist/bridge/index.html, dist/launch/index.html)
 *     by cloning the built dist/index.html and swapping the <head> meta. Every
 *     shell boots the SAME SPA bundle; the router renders the matching route.
 *     This keeps per-page share cards (OG/Twitter) without server rendering, and
 *     gives real files for those routes. There is no catch-all SPA rewrite: an
 *     unknown deep path 404s (acceptable), and — critically — a missing hashed
 *     chunk also 404s honestly instead of being served index.html (HTML that the
 *     browser would then fail to parse as a JS module).
 *  2. Asserts the bundle is free of RainbowKit / WalletConnect / metamask-sdk —
 *     the bridge connects MetaMask + Rabby via EIP-6963 only.
 *
 * Exits non-zero on any problem.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");

function fail(message) {
    console.error(`✗ ${message}`);
    process.exit(1);
}

const indexPath = path.join(dist, "index.html");
if (!fs.existsSync(indexPath)) fail(`dist/index.html missing — run \`vite build\` first.`);
const indexHtml = fs.readFileSync(indexPath, "utf8");
if (!/<script[^>]+src="\/assets\/[^"]+\.js"/.test(indexHtml)) {
    fail("dist/index.html references no /assets/*.js entry — the SPA bundle is missing.");
}

// ── per-route shells ─────────────────────────────────────────────────────────
function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function withMeta(html, { title, desc, url }) {
    return html
        .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
        .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
        .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`)
        .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`)
        .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
        .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
        .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
        .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${esc(desc)}$2`);
}

const ROUTES = [
    {
        dir: "bridge",
        title: "Bridge fee juice to Aztec — Fizz",
        desc: "Bring your own gas: bridge the AZTEC token from your Ethereum wallet (MetaMask or Rabby) into fee juice on your connected Fizz wallet. The wallet auto-completes the claim — nothing to copy.",
        url: "https://fizzwallet.com/bridge/",
    },
    {
        dir: "launch",
        title: "Launch a token on Aztec — Fizz",
        desc: "Design a standard AIP-20 token and deploy it from your Fizz wallet. The page never sees your address or keys — you review and confirm in the wallet.",
        url: "https://fizzwallet.com/launch/",
    },
];

for (const r of ROUTES) {
    const html = withMeta(indexHtml, r);
    if (!html.includes(`<title>${esc(r.title)}</title>`)) {
        fail(`failed to stamp the <title> for /${r.dir}/ — index.html template changed?`);
    }
    const outDir = path.join(dist, r.dir);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "index.html"), html);
    console.log(`✓ dist/${r.dir}/index.html: per-route meta stamped`);
}

// ── bundle hygiene ───────────────────────────────────────────────────────────
// Match package-path signatures (not bare words) so the UI's own prose — e.g.
// "there's no WalletConnect relay" — doesn't trip the check. These strings only
// appear if the corresponding SDK is actually bundled.
const BANNED = ["@walletconnect/", "@rainbow-me/", "metamask-sdk", "@web3modal/"];
const assetsDir = path.join(dist, "assets");
let jsCount = 0;
for (const file of fs.readdirSync(assetsDir)) {
    if (!file.endsWith(".js")) continue;
    jsCount += 1;
    const js = fs.readFileSync(path.join(assetsDir, file), "utf8").toLowerCase();
    for (const banned of BANNED) {
        if (js.includes(banned)) {
            fail(`${file} contains "${banned}" — only wagmi + injected (MetaMask/Rabby) should ship.`);
        }
    }
}
if (jsCount === 0) fail("dist/assets has no .js chunks.");
console.log(`✓ ${jsCount} js chunks: no RainbowKit / WalletConnect / metamask-sdk`);
console.log("✓ postbuild complete");
