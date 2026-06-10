import type { ConfigEnv } from "vite";
import type { ManifestV3Export } from "@crxjs/vite-plugin";

/**
 * The manifest is built as a FUNCTION of the Vite env so the production build
 * can shed the dev-only attack surface (localhost trust). `yarn build` runs in
 * mode "production"; `yarn dev` and unpacked dev builds run otherwise. This
 * mirrors the `import.meta.env.PROD` gating in the background worker, so the
 * trust boundary is enforced at BOTH the manifest layer and the runtime.
 *
 * crxjs's `crx({ manifest })` accepts a `(env) => manifest` function; we type it
 * as ManifestV3Export and use `any` for the body since the two cross-origin
 * isolation keys below predate crxjs's ManifestV3 type.
 */
const buildManifest = (env: ConfigEnv): any => {
    const isProd = env.mode === "production";

    // Cross-origin egress allowlist. The decrypted mnemonic lives in the popup
    // while unlocked, so this is the last line of defense against a compromised
    // bundled dependency exfiltrating it: a malicious dep can run, but it has
    // nowhere to POST. PROD therefore drops `http://localhost:*` / `127.0.0.1:*`
    // (a real exfil channel to any cooperating local listener) and keeps only
    // the Aztec node origins + the CRS CDN. DEV keeps localhost for the sandbox.
    const connectSrc = [
        "'self'",
        // data: — the bundler inlines barretenberg's gzipped wasm as a data: URL
        // that bb.js FETCHES; without it the PXE can't boot. data: transmits
        // nothing anywhere, so the exfiltration posture is intact.
        "data:",
        // Aztec Alpha (Mainnet) node — pinned to the exact host (not a wildcard)
        // to keep the seed-exfil egress allowlist as tight as possible.
        "https://aztec-mainnet.drpc.org",
        // Testnet/devnet nodes.
        "https://*.aztec-labs.com",
        // Proving parameters (CRS) — fetched by bb.js ONCE at first proof.
        "https://crs.aztec-cdn.foundation",
        ...(isProd ? [] : ["http://localhost:*", "http://127.0.0.1:*"]),
    ].join(" ");

    // fizzwallet.com/launch is the only external caller (token-draft hand-off).
    // localhost is allowed ONLY in dev so a local web build can drive the
    // wallet; a published wallet never trusts a localhost page. (The Netlify
    // origin is the owner's active staging host; remove it once fizzwallet.com
    // is the sole domain.)
    const externallyConnectableMatches = [
        "https://fizzwallet.com/*",
        "https://www.fizzwallet.com/*",
        "https://fizzwallet.netlify.app/*",
        ...(isProd ? [] : ["http://localhost/*"]),
    ];

    return {
        manifest_version: 3,
        // Pins the extension ID to bapbaajfnjockbcdhjpgpllflnhgogol on EVERY
        // unpacked install (and the Web Store build). fizzwallet.com/launch
        // messages the wallet by this ID — without the pin every dev machine
        // gets a random one. This is only the PUBLIC key; no private half.
        key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4Pgg5vyd9mDoO0hrNEqXDziJk3bv3Qg9KBhgkv6UhS2t+/AupeQtv7dUwT7O5jaqPefu/Y1GIwQgVDXDzY/mPyP6Fu1fjTK1dT8tnMRdn8iFzmGd6vBtfBDHSC6hVpVV8mlHEuBx6ZQYq+tAwA10Zjv60+JfbEEn9uG40bEHy+mSmTBtMVEWa9EIRhjdaBJEGbM9SoFbBCeBn0ZcgOOZBYb4pZKTD01NSnwutvkdft4ER7RBR0oztoSPVK4rnceFKtsz3Mair/YAVgLesUn3i9xnNtoeQ56EYK+OMiZAuNEdWyk8ftOGH8HWbTSztzlW6oAuDV2G+08Hu4idzBt+DwIDAQAB",
        name: "Fizz — Private Aztec Wallet",
        short_name: "Fizz",
        description:
            "Tokens with sparkle. A lightweight Aztec wallet for quick, low-value private transactions — keys never leave your device.",
        version: "0.1.0",
        icons: {
            16: "src/assets/icon-16.png",
            32: "src/assets/icon-32.png",
            48: "src/assets/icon-48.png",
            128: "src/assets/icon-128.png",
        },
        action: {
            default_popup: "src/popup/index.html",
            default_title: "Fizz",
            default_icon: {
                16: "src/assets/icon-16.png",
                32: "src/assets/icon-32.png",
                48: "src/assets/icon-48.png",
                128: "src/assets/icon-128.png",
            },
        },
        background: {
            service_worker: "src/background/index.ts",
            type: "module",
        },
        permissions: ["storage"],
        externally_connectable: { matches: externallyConnectableMatches },
        // Host patterns ignore ports — localhost covers the sandbox node (8080)
        // + anvil (8545); *.aztec-labs.com covers testnet/devnet; the CRS CDN
        // serves proving params. (The in-wallet L1 funder was removed, so the
        // Sepolia L1 RPC is no longer here.)
        host_permissions: [
            "http://localhost/*",
            "http://127.0.0.1/*",
            "https://aztec-mainnet.drpc.org/*",
            "https://*.aztec-labs.com/*",
            "https://crs.aztec-cdn.foundation/*",
        ],
        // The Aztec stack (PXE, bb.js prover, Noir ACVM, foundation crypto) runs
        // WebAssembly in the popup; MV3 needs 'wasm-unsafe-eval' or the first
        // WebAssembly.instantiate throws. Everything else is locked down hard.
        //  - worker-src 'self' — Vite bundles bb.js's workers as extension files;
        //    Chrome's MV3 validator REJECTS blob: in worker-src.
        //  - style-src 'unsafe-inline' — React inline style attributes.
        //  - img-src data: blob: — QR canvas data-URLs and icon blobs.
        content_security_policy: {
            extension_pages:
                "default-src 'none'; " +
                "script-src 'self' 'wasm-unsafe-eval'; " +
                "worker-src 'self'; " +
                "style-src 'self' 'unsafe-inline'; " +
                "img-src 'self' data: blob:; " +
                "font-src 'self'; " +
                `connect-src ${connectSrc}; ` +
                "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';",
        },
        // Cross-origin isolation makes SharedArrayBuffer available, which lets
        // bb.js prove with multiple threads. require-corp is satisfied by our
        // RPC nodes' `Access-Control-Allow-Origin: *`; same-origin bundled wasm
        // is always allowed under COEP.
        cross_origin_embedder_policy: { value: "require-corp" },
        cross_origin_opener_policy: { value: "same-origin" },
    };
};

export default buildManifest as unknown as ManifestV3Export;
