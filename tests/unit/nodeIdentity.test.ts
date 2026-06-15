import { describe, expect, it } from "vitest";
import { assertNodeIdentity } from "../../src/lib/aztec/wallet";
import { getNetwork } from "../../src/lib/aztec/networks";

// NETWORK-22 / NETWORK-36 — the wrong-chain HARD FAIL and the rollup-version
// soft-warn in checkNodeReachable. Pinning these stops a refactor from silently
// dropping the chain-id guard (which would let a swapped/misconfigured node
// anchor the wallet to a DIFFERENT L1 chain) or from promoting the version warn
// into a hard brick that takes every user offline on a network upgrade.

const MAINNET = getNetwork("alpha"); // l1ChainId 1, rollupVersion pinned
const body = (result: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, result });

describe("assertNodeIdentity (NETWORK-22/36)", () => {
    it("passes a matching chain id + rollup version with no warnings", () => {
        const out = assertNodeIdentity(
            body({ l1ChainId: MAINNET.l1ChainId, rollupVersion: MAINNET.rollupVersion }),
            MAINNET,
        );
        expect(out.warnings).toHaveLength(0);
    });

    it("THROWS on a definite L1 chain-id mismatch (wrong chain is never safe)", () => {
        expect(() =>
            assertNodeIdentity(body({ l1ChainId: 11155111, rollupVersion: MAINNET.rollupVersion }), MAINNET),
        ).toThrow(/wrong chain/i);
    });

    it("coerces a string l1ChainId (JSON-RPC sometimes serializes it as a string)", () => {
        // Matching, but as a string → must NOT throw.
        expect(() =>
            assertNodeIdentity(body({ l1ChainId: String(MAINNET.l1ChainId) }), MAINNET),
        ).not.toThrow();
        // Mismatching string → still throws.
        expect(() => assertNodeIdentity(body({ l1ChainId: "999" }), MAINNET)).toThrow(/wrong chain/i);
    });

    it("falls back to chainId when l1ChainId is absent", () => {
        expect(() => assertNodeIdentity(body({ chainId: 999 }), MAINNET)).toThrow(/wrong chain/i);
        expect(() => assertNodeIdentity(body({ chainId: MAINNET.l1ChainId }), MAINNET)).not.toThrow();
    });

    it("warns (does NOT throw) when l1ChainId is missing entirely — SDK shape drift", () => {
        const out = assertNodeIdentity(body({ rollupVersion: MAINNET.rollupVersion }), MAINNET);
        expect(out.warnings.join(" ")).toMatch(/l1ChainId/i);
    });

    it("warns (does NOT throw) on a rollup-version mismatch — no offline brick on upgrade", () => {
        const out = assertNodeIdentity(
            body({ l1ChainId: MAINNET.l1ChainId, rollupVersion: 123456 }),
            MAINNET,
        );
        expect(out.warnings.join(" ")).toMatch(/rollup version/i);
    });

    it("skips BOTH checks for the sandbox/custom sentinels (l1ChainId 0 / rollupVersion 0)", () => {
        const custom = { name: "Custom", nodeUrl: "http://localhost:8080", l1ChainId: 0, rollupVersion: 0 };
        // A wildly wrong body must be tolerated for an unpinned network.
        const out = assertNodeIdentity(body({ l1ChainId: 424242, rollupVersion: 999 }), custom);
        expect(out.warnings).toHaveLength(0);
    });

    it("tolerates a malformed body without throwing the wrong error", () => {
        // No result / null / non-object → treated as 'no identity fields' → for a
        // pinned network that means the chain-id field is absent (a warning), never
        // a crash.
        for (const b of [null, undefined, {}, { result: null }, "nonsense", 42]) {
            expect(() => assertNodeIdentity(b, MAINNET)).not.toThrow(/cannot read|undefined is not/i);
        }
    });
});
