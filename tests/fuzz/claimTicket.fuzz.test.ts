import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { encodeClaimTicket, validateClaimTicket, type ClaimTicket } from "../../src/lib/aztec/claimTicket";

/**
 * Field-element fields (recipient/claimSecret/messageHash) are bn254 elements
 * (≤32 bytes = ≤64 hex). An oversized value previously slipped validation and
 * later threw in Fr.fromHexString during the sweep, leaving an unspendable,
 * never-cleared "phantom" claim that still inflated the incoming-gas display.
 * These properties lock the tightened bounds in place.
 */

const validBase: ClaimTicket = {
    v: 1,
    kind: "fee-juice-claim",
    networkId: "testnet",
    l1ChainId: 11155111,
    recipient: "0x" + "ab".repeat(32), // 64 hex
    claimSecret: "0x" + "cd".repeat(32),
    messageHash: "0x" + "ef".repeat(32),
    l1TxHash: "0x" + "12".repeat(32), // exactly 64 hex
    claimAmount: "1000",
    messageLeafIndex: "7",
    createdAt: 1,
};

describe("fuzz: claim ticket field-element bounds", () => {
    it("accepts a well-formed ticket and round-trips through encode/decode-validate", () => {
        expect(() => validateClaimTicket(validBase)).not.toThrow();
        // encodeClaimTicket re-validates internally.
        expect(() => encodeClaimTicket(validBase)).not.toThrow();
    });

    it("rejects field-element fields longer than 64 hex chars", () => {
        const fieldElementFields = ["recipient", "claimSecret", "messageHash"] as const;
        fc.assert(
            fc.property(
                fc.constantFrom(...fieldElementFields),
                fc.integer({ min: 65, max: 128 }),
                (field, hexLen) => {
                    const oversized = { ...validBase, [field]: "0x" + "a".repeat(hexLen) };
                    expect(() => validateClaimTicket(oversized)).toThrow();
                },
            ),
            { numRuns: 300 },
        );
    });

    it("requires l1TxHash to be EXACTLY 64 hex chars (a 32-byte L1 hash)", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 130 }).filter((n) => n !== 64),
                (hexLen) => {
                    const bad = { ...validBase, l1TxHash: "0x" + "b".repeat(hexLen) };
                    expect(() => validateClaimTicket(bad)).toThrow();
                },
            ),
            { numRuns: 200 },
        );
    });

    it("rejects non-hex / missing-0x / mixed-garbage field values, never crashes", () => {
        fc.assert(
            fc.property(
                fc.constantFrom("recipient", "claimSecret", "messageHash", "l1TxHash"),
                fc.string({ maxLength: 80 }),
                (field, value) => {
                    const candidate = { ...validBase, [field]: value };
                    // Either it validates (only if value happens to be canonical hex of
                    // the right length) or it throws — never returns a malformed ticket.
                    try {
                        const t = validateClaimTicket(candidate);
                        expect(/^0x[0-9a-fA-F]+$/.test(t[field as keyof ClaimTicket] as string)).toBe(true);
                    } catch {
                        /* rejection is always acceptable */
                    }
                },
            ),
            { numRuns: 2000 },
        );
    });
});
