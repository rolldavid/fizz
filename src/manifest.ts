import type { ConfigEnv } from "vite";
import type { ManifestV3Export } from "@crxjs/vite-plugin";

/**
 * The manifest is built as a FUNCTION of the Vite env so the production build
 * can shed the dev-only attack surface (localhost trust). `yarn build` runs in
 * mode "production"; `yarn dev` and unpacked dev builds run otherwise.
 *
 * FAIL-CLOSED gate: `isProd` is true when EITHER the Vite mode is "production"
 * OR NODE_ENV is "production". This is load-bearing — the background worker's
 * runtime origin gate keys off `import.meta.env.PROD`, which Vite derives from
 * NODE_ENV (true for any `vite build`, even `--mode staging`). Keying the
 * manifest off the mode STRING alone would diverge from that: a
 * `vite build --mode staging` would re-add localhost to connect-src /
 * externally_connectable / host_permissions (a real seed-exfil channel) and
 * ship source maps, while the runtime believed it was production. Honoring
 * NODE_ENV here keeps all three build-time gates and the runtime gate aligned,
 * and the dev surface only ever reappears for a genuine dev build.
 *
 * crxjs's `crx({ manifest })` accepts a `(env) => manifest` function; we type it
 * as ManifestV3Export and use `any` for the body since the two cross-origin
 * isolation keys below predate crxjs's ManifestV3 type.
 */
const buildManifest = (env: ConfigEnv): any => {
    const isProd = env.mode === "production" || process.env.NODE_ENV === "production";

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
        // drpc (keyed): the Aztec mainnet node AND the read-only L1 RPCs the
        // bridge uses for receipt verification + claim recovery (networks.ts).
        // One pinned host covers all three networks. Removing it silently
        // strands every bridge at "sent" — the CSP block is indistinguishable
        // from "not mined yet".
        "https://lb.drpc.live",
        // Self-hosted mainnet Aztec node (networks.ts mainnet nodeUrl). A single
        // dedicated node — not a load balancer — so the PXE never sees the
        // inconsistent chain heights that caused "Unknown block" sync failures.
        "https://aztec.fizzwallet.com",
        // Testnet + devnet nodes — the EXACT hosts used (networks.ts), not a
        // whole-domain wildcard: `https://*.aztec-labs.com` would make any
        // current-or-future subdomain (incl. one obtainable via subdomain
        // takeover) a valid seed-exfil egress, undermining the backstop above.
        // validateCustomNodeUrl is pinned to this same set so the two can't drift.
        "https://rpc.testnet.aztec-labs.com",
        "https://v4-devnet-2.aztec-labs.com",
        // Proving parameters (CRS) — fetched by bb.js ONCE at first proof.
        "https://crs.aztec-cdn.foundation",
        ...(isProd ? [] : ["http://localhost:*", "http://127.0.0.1:*"]),
    ].join(" ");

    // fizzwallet.com/bridge is the only external caller (fee-juice hand-off).
    // localhost is allowed ONLY in dev so a local web build can drive the
    // wallet; a published wallet never trusts a localhost page.
    const externallyConnectableMatches = [
        "https://fizzwallet.com/*",
        "https://www.fizzwallet.com/*",
        ...(isProd ? [] : ["http://localhost/*"]),
    ];

    return {
        manifest_version: 3,
        // The Chrome Web Store item's PUBLIC key (no private half) — pins the
        // extension ID to kadklgafmpoomnhnbjkeajapglmmegfj, the PUBLISHED id,
        // on every unpacked dev install too, so fizzwallet.com (EXTENSION_ID
        // in web/src/config.ts, which must match) reaches dev and store builds
        // alike. NOTE: `yarn package:store` strips this field — the store
        // rejects uploads carrying `key` and derives the id from its own copy.
        key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkjwHDrGeKy5GLPwqgN98LObU9loNF1rGha11Y/Pk5kI6CWu4oTBFnualS5jt62Cd4wFM7OUx3ANPAIGgsZ7i56Z0i0TuvK+oqb22C5JToAc4PLLYnVGbIYHaPQJHYpBmjROBHIh4odOU73+6c+4hDrEWIeaXk5V/MhQ5RzMeXyM5nRfiUbc8IvyMyMu3AahKqtH1Cai9n0CG61eGYtZnqIc6t9V5W9R2JGVg6LDeoNS+dNyNXpheqtLtZrOixmBNM6juNzPPjPEGaCwiLlSfCVO3d8RrOK9zDsCp7BlKno8dG6a6El3sD0+tXEAaqY48QJMKzGw3gsbl/n6Ds92x9QIDAQAB",
        name: "Fizz Wallet",
        short_name: "Fizz Wallet",
        description: "A lightweight wallet for the Aztec Network",
        version: "0.1.3",
        icons: {
            16: "o.png",
            32: "o.png",
            48: "o.png",
            128: "o.png",
        },
        action: {
            default_popup: "src/popup/index.html",
            default_title: "Fizz Wallet",
            default_icon: {
                16: "o.png",
                32: "o.png",
                48: "o.png",
                128: "o.png",
            },
        },
        background: {
            service_worker: "src/background/index.ts",
            type: "module",
        },
        permissions: ["storage"],
        externally_connectable: { matches: externallyConnectableMatches },
        // Host patterns ignore ports — localhost covers the sandbox node (8080)
        // + anvil (8545); lb.drpc.live is the mainnet Aztec node AND the read-only
        // L1 RPCs the bridge uses to verify deposit receipts; rpc.testnet and
        // v4-devnet-2.aztec-labs.com are the testnet/devnet nodes (pinned, not a
        // wildcard); crs.aztec-cdn.foundation serves proving params (see connectSrc).
        // localhost is DEV-ONLY: prod drops it to mirror the connect-src /
        // externally_connectable gates, minimize the install-time permission
        // footprint, and avoid a Web Store review flag.
        host_permissions: [
            ...(isProd ? [] : ["http://localhost/*", "http://127.0.0.1/*"]),
            "https://lb.drpc.live/*",
            "https://aztec.fizzwallet.com/*",
            "https://rpc.testnet.aztec-labs.com/*",
            "https://v4-devnet-2.aztec-labs.com/*",
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
