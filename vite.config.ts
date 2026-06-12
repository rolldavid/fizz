import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import { crx } from "@crxjs/vite-plugin";
import { nodePolyfills, type PolyfillOptions } from "vite-plugin-node-polyfills";
import manifest from "./src/manifest";

// Workaround for vite-plugin-node-polyfills shim resolution in ESM yarn workspaces
// (mirrors the workaround used in aztec-packages/playground/vite.config.ts).
const nodePolyfillsFix = (options?: PolyfillOptions): Plugin => {
    return {
        ...nodePolyfills(options),
        // vite-plugin-node-polyfills shim resolution; types do not include this hook here
        resolveId(source: string) {
            const m = /^vite-plugin-node-polyfills\/shims\/(buffer|global|process)$/.exec(source);
            if (m) {
                return `./node_modules/vite-plugin-node-polyfills/shims/${m[1]}/dist/index.cjs`;
            }
        },
    };
};

export default defineConfig(({ mode }) => {
    // FAIL-CLOSED production signal: true for any production build, including
    // `vite build --mode staging` (where Vite sets NODE_ENV=production but the
    // mode string isn't "production"). Drives sourcemap + LOG_LEVEL so neither
    // the full source nor verbose address-leaking logs ever ship by accident,
    // and stays consistent with the manifest's isProd and the runtime PROD gate.
    const isProd = mode === "production" || process.env.NODE_ENV === "production";
    return {
    plugins: [
        react(),
        nodePolyfillsFix({ include: ["buffer", "path", "process", "net", "tty"] }),
        crx({ manifest }),
    ],
    server: {
        // bb.js WASM threads need cross-origin isolation
        headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
        },
    },
    build: {
        target: "esnext",
        // No source maps in the shipped extension: they reconstruct the full
        // source (incl. security-design comments) for anyone who installs it,
        // and double the package size. Keep them in dev builds only.
        sourcemap: !isProd,
        rollupOptions: {
            // bb.js + noir wasm artifacts are large; bumping warning limit so we don't
            // spam the console on every build.
            output: {
                manualChunks: undefined,
            },
        },
        chunkSizeWarningLimit: 5000,
    },
    define: {
        "process.env": JSON.stringify({
            // The Aztec SDK logger reads this. "info"/"warn" can print addresses +
            // tx detail to the console — a privacy sink in a shipped wallet
            // (devtools, screen-share, console-scraping extensions). Ship "error"
            // so prod stays quiet; verbose only in dev.
            LOG_LEVEL: isProd ? "error" : "info",
        }),
        // Shown on Home so a tester can verify the loaded build is current.
        __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
        },
    };
});
