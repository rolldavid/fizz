import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
    manifest_version: 3,
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
    // Host patterns ignore ports — these cover the sandbox node (8080), the
    // sandbox L1 anvil (8545), any custom local node, and the hosted networks.
    host_permissions: [
        "http://localhost/*",
        "http://127.0.0.1/*",
        "https://*.aztec-labs.com/*",
        // L1 RPC for the in-wallet funding account (fee-juice bridging).
        "https://ethereum-sepolia-rpc.publicnode.com/*",
    ],
    // The Aztec stack (PXE WASMSimulator, bb.js prover, Noir ACVM, foundation
    // crypto) runs WebAssembly inside the popup. MV3 no longer grants
    // 'wasm-unsafe-eval' by default, so without this the very first
    // WebAssembly.instantiate throws "Wasm code generation disallowed by
    // embedder" and EmbeddedWallet.create() fails on every network.
    //
    // Everything else is locked down hard. The decrypted mnemonic lives in this
    // page's memory while unlocked, so the one catastrophic path is a
    // compromised bundled dependency exfiltrating it — `connect-src` pins
    // network egress to the Aztec node origins only (localhost for the sandbox
    // + anvil, *.aztec-labs.com for testnet/devnet). A malicious dep can still
    // run, but it has nowhere to send secrets.
    //  - worker-src 'self' — Vite bundles bb.js's proving workers as extension
    //    files (`new Worker(new URL(...))`), so no blob: needed. Chrome's MV3
    //    validator REJECTS blob: in worker-src outright ("Insecure CSP value"),
    //    so adding it would make the extension uninstallable — verified by the
    //    real-Chrome smoke test.
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
            // data: is required: the bundler inlines barretenberg's gzipped
            // wasm as a data: URL and bb.js FETCHES it — without data: here the
            // PXE can't boot (verified in the real-Chrome gate). data: fetches
            // transmit nothing anywhere, so the exfiltration posture is intact.
            "connect-src 'self' data: http://localhost:* http://127.0.0.1:* https://*.aztec-labs.com https://ethereum-sepolia-rpc.publicnode.com; " +
            "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';",
    },
    // Cross-origin isolation makes SharedArrayBuffer available, which lets bb.js
    // prove with multiple threads instead of silently falling back to a single
    // thread (the difference between a few seconds and minutes per private tx).
    // require-corp is satisfied by our RPC nodes because they return
    // `Access-Control-Allow-Origin: *`; a CORS-passing response opts in to COEP
    // without needing a separate CORP header. Same-origin bundled assets (the
    // wasm blobs, workers) are always allowed under COEP.
    cross_origin_embedder_policy: { value: "require-corp" },
    cross_origin_opener_policy: { value: "same-origin" },
    // @crxjs/vite-plugin's ManifestV3Options type predates the two cross-origin
    // isolation keys above, so cast past it. The `as` cast disables excess-property
    // checking while still verifying the rest of the literal is a valid manifest.
} as Parameters<typeof defineManifest>[0]);
