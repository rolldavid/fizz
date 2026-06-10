import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import { nodePolyfills, type PolyfillOptions } from "vite-plugin-node-polyfills";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Workaround for vite-plugin-node-polyfills shim resolution (mirrors the
// extension's root vite.config.ts and aztec-packages/playground).
const nodePolyfillsFix = (options?: PolyfillOptions): Plugin => {
    return {
        ...nodePolyfills(options),
        resolveId(source: string) {
            const m = /^vite-plugin-node-polyfills\/shims\/(buffer|global|process)$/.exec(source);
            if (m) {
                return path.join(here, `node_modules/vite-plugin-node-polyfills/shims/${m[1]}/dist/index.cjs`);
            }
        },
    };
};

/**
 * bb.js ships TWO copies of the barretenberg WASM as ~3.5 MB base64 data-url
 * modules: `barretenberg.js` (plain memory) and `barretenberg-threads.js`
 * (shared memory). The threaded one is only ever loaded when the page is
 * crossOriginIsolated — which fizzwallet.com never is (Netlify serves
 * landing/ with no COOP/COEP headers, and netlify.toml must stay
 * build-free). Aliasing threads → plain keeps a dead 3.5 MB chunk out of the
 * committed landing/webassets output.
 *
 * Safety: the only bb.js entry this app touches is BarretenbergSync (via
 * @aztec/aztec.js → computeSecretHash → poseidon2), which always requests
 * threads=1 (fetchModuleAndThreads(1)) — so even in a hypothetical
 * cross-origin-isolated future the plain-memory wasm remains correct here.
 */
const bbFetchCodeDir = path.join(
    here,
    "node_modules/@aztec/bb.js/dest/browser/barretenberg_wasm/fetch_code/browser",
);
const dropThreadedBbWasm = (): Plugin => ({
    name: "fizz-drop-threaded-bb-wasm",
    // "pre": must answer before vite's core resolver settles the relative import.
    enforce: "pre",
    resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith("barretenberg-threads.js")) return;
        if (!importer || !importer.includes(path.join("barretenberg_wasm", "fetch_code"))) return;
        const target = path.join(bbFetchCodeDir, "barretenberg.js");
        if (!fs.existsSync(target)) {
            throw new Error(
                `bb.js layout changed: ${target} not found — update dropThreadedBbWasm in web/vite.config.ts.`,
            );
        }
        return target;
    },
});

export default defineConfig({
    // All hashed assets are emitted under (and referenced from) /webassets/ so
    // the SAME build serves both /bridge/ and /launch/ on fizzwallet.com.
    // scripts/deploy-to-landing.mjs copies dist/ into ../landing accordingly.
    base: "/webassets/",
    plugins: [
        react(),
        nodePolyfillsFix({ include: ["buffer", "path", "process", "util", "net", "tty"] }),
        dropThreadedBbWasm(),
    ],
    build: {
        target: "esnext",
        sourcemap: false,
        outDir: "dist",
        rollupOptions: {
            input: {
                bridge: path.join(here, "bridge/index.html"),
                launch: path.join(here, "launch/index.html"),
            },
        },
        // The lazy aztec.js/bb.js chunk (poseidon2 wasm as a data-url) is
        // inherently large; it is only fetched when a bridge flow starts.
        chunkSizeWarningLimit: 4096,
    },
    define: {
        // The Aztec SDK logger reads this; "info" would log addresses to the
        // console — a privacy sink on a public page.
        "process.env.LOG_LEVEL": JSON.stringify("warn"),
    },
});
