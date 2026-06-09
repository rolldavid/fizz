import { defineWorkspace } from "vitest/config";

/**
 * Two projects:
 *  - unit: fast, hermetic tests (incl. fast-check fuzz/property suites). No network.
 *  - e2e:  full-lifecycle tests against a LIVE local Aztec network
 *          (`aztec start --local-network`). Sequential, long timeouts —
 *          these prove real txs end-to-end with the wallet's own lib code.
 */
export default defineWorkspace([
    {
        test: {
            name: "unit",
            include: ["tests/unit/**/*.test.ts", "tests/fuzz/**/*.test.ts"],
            environment: "node",
            setupFiles: ["tests/setup/chrome-stub.ts"],
            testTimeout: 30_000,
            hookTimeout: 30_000,
        },
    },
    {
        test: {
            name: "e2e",
            include: ["tests/e2e/**/*.test.ts", "tests/browser/**/*.test.ts"],
            environment: "node",
            setupFiles: ["tests/setup/chrome-stub.ts"],
            // Real txs against a live network: account deploys, token deploys,
            // mints, transfers. Generous budgets; suites run strictly sequentially.
            testTimeout: 600_000,
            hookTimeout: 600_000,
            pool: "forks",
            poolOptions: { forks: { singleFork: true } },
            sequence: { concurrent: false },
        },
    },
]);
