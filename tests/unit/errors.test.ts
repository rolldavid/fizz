import { describe, it, expect } from "vitest";
import {
    describeError,
    scrubAddresses,
    humanizeTxError,
    PostBroadcastBookkeepingError,
    redact,
} from "../../src/lib/errors";

const ADDR64 = "0x" + "a".repeat(64);
const ADDR40 = "0x" + "b".repeat(40);

describe("scrubAddresses", () => {
    it("collapses 64-hex (Aztec address / tx hash) and 40-hex (ETH address)", () => {
        const out = scrubAddresses(`note for ${ADDR64} from ${ADDR40} done`);
        expect(out).not.toContain(ADDR64);
        expect(out).not.toContain(ADDR40);
        expect(out).toContain("⟨addr⟩");
    });
    it("leaves non-address text untouched", () => {
        expect(scrubAddresses("plain error, no secrets")).toBe("plain error, no secrets");
    });
});

describe("describeError — totality + scrubbing (ERRORS-01/02, PRIVACY-01/35)", () => {
    it("never throws across input shapes", () => {
        const circular: any = {};
        circular.self = circular;
        const inputs: unknown[] = [
            new Error("boom"),
            new DOMException("quota", "QuotaExceededError"),
            { message: "objmsg" },
            circular, // JSON.stringify throws → caught
            null,
            undefined,
            42,
            "str",
        ];
        for (const i of inputs) expect(() => describeError(i)).not.toThrow();
    });
    it("surfaces a DOMException name (not '[object DOMException]')", () => {
        const out = describeError(new DOMException("db closing", "InvalidStateError"));
        expect(out).toContain("InvalidStateError");
        expect(out).not.toContain("[object");
    });
    it("scrubs an address embedded in an Error message", () => {
        const out = describeError(new Error(`no notes for ${ADDR64}`));
        expect(out).not.toContain(ADDR64);
    });
});

describe("humanizeTxError — bucket priority (ERRORS-03/04/22/27)", () => {
    it("Bucket 0: PostBroadcastBookkeepingError → verify-in-Activity with the hash prefix", () => {
        const e = new PostBroadcastBookkeepingError(ADDR64, new Error("lock"));
        const msg = humanizeTxError(e);
        expect(msg.toLowerCase()).toContain("submitted");
        expect(msg.toLowerCase()).toContain("transaction history");
        expect(msg).toContain(ADDR64.slice(0, 12));
        expect(msg.toLowerCase()).not.toContain("try again"); // never blind-retry
    });
    it("Bucket 1: wallet-locked error → unlock-and-verify, not retry", () => {
        const msg = humanizeTxError(new Error("Encrypted storage unavailable — the wallet is locked."));
        expect(msg.toLowerCase()).toContain("locked");
        expect(msg.toLowerCase()).toContain("transaction history");
    });
    it("Bucket 2: receipt failure → verify before resending", () => {
        const msg = humanizeTxError(new Error("[node_getTxReceipt] Expected string, received object"));
        expect(msg.toLowerCase()).toContain("submitted");
        expect(msg.toLowerCase()).not.toMatch(/wait about a minute/);
    });
    it("Bucket 3: pre-broadcast sync drift → safe to retry in a minute", () => {
        const msg = humanizeTxError(new Error("[node_getBlocks] Unknown block"));
        expect(msg.toLowerCase()).toContain("out of sync");
        expect(msg.toLowerCase()).toContain("try again");
    });
    it("a combined receipt+reorg string hits the SAFE receipt bucket, not the retry bucket", () => {
        const msg = humanizeTxError(new Error("node_getTxReceipt failed during reorg / unknown block"));
        expect(msg.toLowerCase()).toContain("submitted"); // bucket 2 wins (safety)
    });
    it("unknown errors pass through describeError (scrubbed)", () => {
        const msg = humanizeTxError(new Error(`weird failure at ${ADDR40}`));
        expect(msg).not.toContain(ADDR40);
        expect(msg).toContain("weird failure");
    });
});

describe("redact", () => {
    it("truncates long values and passes short ones", () => {
        expect(redact(ADDR64)).toBe(`${ADDR64.slice(0, 10)}…`);
        expect(redact("short")).toBe("short");
    });
});
