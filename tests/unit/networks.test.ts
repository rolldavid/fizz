import { describe, expect, it } from "vitest";
import {
    DEFAULT_NETWORK_ID,
    NETWORKS,
    getNetwork,
    validateCustomNodeUrl,
    ALLOWED_NODE_HOSTS,
} from "../../src/lib/aztec/networks";
import buildManifest from "../../src/manifest";

function prodConnectSrc(): string {
    const m: any = (buildManifest as any)({ mode: "production", command: "build" });
    return String(m.content_security_policy.extension_pages);
}

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

    // NETWORK-08/31 — mainnet uses ONE dedicated host (not a load balancer).
    it("the mainnet (alpha) entry is the single dedicated host", () => {
        const alpha = getNetwork("alpha");
        expect(alpha.nodeUrl).toBe("https://aztec.fizzwallet.com");
        expect(alpha.nodeUrl).not.toMatch(/lb\.|load-balanc|drpc/i);
    });
});

describe("validateCustomNodeUrl (NETWORK-05/06/07)", () => {
    it("accepts a localhost node", () => {
        expect(validateCustomNodeUrl("http://localhost:8080")).toMatch(/^http:\/\/localhost/);
    });
    it("accepts an allowlisted https remote", () => {
        expect(validateCustomNodeUrl("https://rpc.testnet.aztec-labs.com")).toContain(
            "rpc.testnet.aztec-labs.com",
        );
    });
    it("rejects a non-http(s) protocol", () => {
        expect(() => validateCustomNodeUrl("ftp://evil.example")).toThrow();
    });
    it("rejects a plain-http remote (TLS required off localhost)", () => {
        expect(() => validateCustomNodeUrl("http://remote.example")).toThrow(/https/i);
    });
    it("rejects a remote host not in the allowlist", () => {
        expect(() => validateCustomNodeUrl("https://evil.example")).toThrow(/content-security/i);
    });
});

describe("manifest CSP guards (RELEASE-09, NETWORK-02/04)", () => {
    it("every ALLOWED_NODE_HOSTS host is present in the prod connect-src", () => {
        const cs = prodConnectSrc();
        for (const host of ALLOWED_NODE_HOSTS) {
            expect(cs, `connect-src must allow ${host}`).toContain(`https://${host}`);
        }
    });
    it("the prod connect-src has no wildcard host", () => {
        const cs = prodConnectSrc();
        const connect = cs.split("connect-src")[1]?.split(";")[0] ?? "";
        expect(connect).not.toContain("*");
    });
    it("the prod build drops localhost from connect-src", () => {
        const cs = prodConnectSrc();
        const connect = cs.split("connect-src")[1]?.split(";")[0] ?? "";
        expect(connect).not.toContain("localhost");
    });
});
