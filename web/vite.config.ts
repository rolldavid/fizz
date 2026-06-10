import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import { nodePolyfills, type PolyfillOptions } from "vite-plugin-node-polyfills";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Workaround for vite-plugin-node-polyfills shim resolution (mirrors the
// extension's root vite.config.ts and aztec-packages/playground). wagmi/viem
// still expect a few node globals (buffer/process) in the browser.
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

export default defineConfig({
    // Single-page app served at the domain root. One entry (index.html), client-
    // side routing; scripts/postbuild.mjs emits per-route HTML shells for SEO/OG.
    base: "/",
    plugins: [react(), nodePolyfillsFix({ include: ["buffer", "path", "process", "util", "net", "tty"] })],
    build: {
        target: "esnext",
        sourcemap: false,
        outDir: "dist",
        // The lazy wagmi/viem chunk (loaded only when the ETH wallet connects) is
        // sizeable; route chunks are split out so the home payload stays small.
        chunkSizeWarningLimit: 4096,
    },
    define: {
        // The Aztec SDK logger reads this; "info" would log addresses to the
        // console — a privacy sink on a public page.
        "process.env.LOG_LEVEL": JSON.stringify("warn"),
    },
});
