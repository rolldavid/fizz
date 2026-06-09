import { describe, expect, it } from "vitest";
import { formatUnits, parseUnits } from "../../src/lib/aztec/balances";
import {
    MAX_U128,
    assertPositiveAmount,
    assertWithinU128,
} from "../../src/lib/aztec/tokenContract";

describe("parseUnits", () => {
    it("parses integers", () => {
        expect(parseUnits("1", 18)).toBe(10n ** 18n);
        expect(parseUnits("0", 18)).toBe(0n);
        expect(parseUnits("1000000", 0)).toBe(1000000n);
    });

    it("parses decimals exactly (no float)", () => {
        expect(parseUnits("1.2345", 18)).toBe(1234500000000000000n);
        expect(parseUnits("0.000000000000000001", 18)).toBe(1n);
        expect(parseUnits(".5", 1)).toBe(5n);
        expect(parseUnits("5.", 1)).toBe(50n);
    });

    it("trims whitespace", () => {
        expect(parseUnits("  7.5 ", 1)).toBe(75n);
    });

    it("rejects empty and digitless input", () => {
        expect(() => parseUnits("", 18)).toThrow();
        expect(() => parseUnits("   ", 18)).toThrow();
        expect(() => parseUnits(".", 18)).toThrow(); // regression: used to parse to 0n
    });

    it("rejects malformed numbers", () => {
        for (const bad of ["1..2", "1.2.3", "1e5", "-1", "+1", "0x10", "1,000", "NaN", "Infinity", "١٢٣"]) {
            expect(() => parseUnits(bad, 18), bad).toThrow();
        }
    });

    it("rejects excess fractional digits rather than rounding", () => {
        expect(() => parseUnits("1.123", 2)).toThrow(/Too many decimals/);
        expect(() => parseUnits("0.1", 0)).toThrow(/Too many decimals/);
    });

    it("rejects invalid decimals parameter", () => {
        expect(() => parseUnits("1", -1)).toThrow();
        expect(() => parseUnits("1", 1.5)).toThrow();
        expect(() => parseUnits("1", 99)).toThrow();
    });

    it("handles amounts beyond u128 (callers must range-check)", () => {
        const huge = parseUnits("340282366920938463463374607431768211456", 0); // 2^128
        expect(huge).toBe(MAX_U128 + 1n);
        expect(() => assertWithinU128(huge)).toThrow(/u128/);
        expect(() => assertWithinU128(MAX_U128)).not.toThrow();
    });
});

describe("formatUnits", () => {
    it("formats zero and integers", () => {
        expect(formatUnits(0n, 18)).toBe("0");
        expect(formatUnits(5n * 10n ** 18n, 18)).toBe("5");
    });

    it("formats fractions with trailing-zero trim and cap", () => {
        expect(formatUnits(1234500000000000000n, 18)).toBe("1.2345");
        expect(formatUnits(1200000000000000000n, 18)).toBe("1.2");
        expect(formatUnits(1234567890000000000n, 18)).toBe("1.2345"); // capped at 4
        expect(formatUnits(1234567890000000000n, 18, 9)).toBe("1.23456789");
    });

    it("renders dust below the display cap as bare whole part", () => {
        expect(formatUnits(1n, 18)).toBe("0");
    });

    it("round-trips when display precision is not truncated", () => {
        const v = 123456789n;
        expect(parseUnits(formatUnits(v, 6, 6), 6)).toBe(v);
    });
});

describe("amount guards", () => {
    it("rejects zero and negative tx amounts", () => {
        expect(() => assertPositiveAmount(0n)).toThrow(/greater than zero/);
        expect(() => assertPositiveAmount(-5n)).toThrow(/greater than zero/);
        expect(() => assertPositiveAmount(1n)).not.toThrow();
    });
});
