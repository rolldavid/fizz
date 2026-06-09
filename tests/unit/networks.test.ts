import { describe, expect, it } from "vitest";
import { DEFAULT_NETWORK_ID, NETWORKS, getNetwork } from "../../src/lib/aztec/networks";

describe("network registry", () => {
    it("default network exists", () => {
        expect(() => getNetwork(DEFAULT_NETWORK_ID)).not.toThrow();
    });

    it("throws on unknown network id", () => {
        expect(() => getNetwork("mainnet" as any)).toThrow(/Unknown network/);
    });

    it("ids are unique and node URLs are http(s)", () => {
        const ids = NETWORKS.map((n) => n.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const n of NETWORKS) {
            expect(n.nodeUrl, n.id).toMatch(/^https?:\/\//);
            // Only localhost may be plain http — remote nodes must be TLS.
            if (!n.nodeUrl.includes("localhost") && !n.nodeUrl.includes("127.0.0.1")) {
                expect(n.nodeUrl, `${n.id} must use https`).toMatch(/^https:\/\//);
            }
            expect(n.l1ChainId, n.id).toBeGreaterThan(0);
            expect(n.name.length, n.id).toBeGreaterThan(0);
        }
    });

    it("faucet URLs, when present, are https", () => {
        for (const n of NETWORKS) {
            if (n.faucetUrl) expect(n.faucetUrl).toMatch(/^https:\/\//);
        }
    });
});
