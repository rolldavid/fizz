import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatUnits, parseUnits } from "../../src/lib/aztec/balances";

/**
 * Property/fuzz suite for the amount codec. These functions sit directly on the
 * money path (user input → bigint base units), so they get adversarial input.
 */

const decimalsArb = fc.integer({ min: 0, max: 18 });
// Amounts up to well beyond u128 to make sure nothing wraps or goes float.
const amountArb = fc.bigInt({ min: 0n, max: (1n << 160n) - 1n });

describe("fuzz: parseUnits/formatUnits", () => {
    it("format → parse round-trips exactly when display keeps full precision", () => {
        fc.assert(
            fc.property(amountArb, decimalsArb, (value, decimals) => {
                const s = formatUnits(value, decimals, decimals);
                // Dust below 1 whole unit with decimals=0 cannot occur; otherwise
                // full-precision format must parse back to the identical bigint.
                expect(parseUnits(s, decimals)).toBe(value);
            }),
            { numRuns: 2000 },
        );
    });

    it("parse of well-formed strings never throws and scales correctly", () => {
        const wellFormed = fc
            .tuple(
                fc.bigInt({ min: 0n, max: 10n ** 30n }),
                decimalsArb,
            )
            .chain(([whole, decimals]) =>
                fc
                    .integer({ min: 0, max: decimals })
                    .map((fracLen) => ({ whole, decimals, fracLen })),
            )
            .chain(({ whole, decimals, fracLen }) =>
                fc
                    .bigInt({ min: 0n, max: fracLen === 0 ? 0n : 10n ** BigInt(fracLen) - 1n })
                    .map((frac) => ({ whole, decimals, fracLen, frac })),
            );
        fc.assert(
            fc.property(wellFormed, ({ whole, decimals, fracLen, frac }) => {
                const fracStr = fracLen === 0 ? "" : "." + frac.toString().padStart(fracLen, "0");
                const s = `${whole}${fracStr}`;
                const expected =
                    whole * 10n ** BigInt(decimals) +
                    (fracLen === 0 ? 0n : frac * 10n ** BigInt(decimals - fracLen));
                expect(parseUnits(s, decimals)).toBe(expected);
            }),
            { numRuns: 2000 },
        );
    });

    it("adversarial strings either throw or yield a non-negative bigint — never NaN/negative/crash", () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 40 }), decimalsArb, (s, decimals) => {
                let out: bigint | undefined;
                try {
                    out = parseUnits(s, decimals);
                } catch {
                    return; // rejection is always acceptable
                }
                expect(typeof out).toBe("bigint");
                expect(out! >= 0n).toBe(true);
                // Anything accepted must be purely [0-9.] after trim.
                expect(/^\d*\.?\d*$/.test(s.trim())).toBe(true);
                expect(/\d/.test(s)).toBe(true);
            }),
            { numRuns: 5000 },
        );
    });

    it("unicode digit lookalikes and exotic whitespace are rejected", () => {
        const evil = ["١٢٣", "𝟙𝟚", "1 000", "10​", "１２", "10e2", "0b101", "0o17"];
        for (const s of evil) {
            expect(() => parseUnits(s, 18), JSON.stringify(s)).toThrow();
        }
    });

    it("formatUnits never throws for any bigint/decimals and emits canonical shape", () => {
        fc.assert(
            fc.property(
                fc.bigInt({ min: -(1n << 200n), max: 1n << 200n }),
                decimalsArb,
                fc.integer({ min: 0, max: 18 }),
                (v, d, maxFrac) => {
                    const s = formatUnits(v, d, maxFrac);
                    expect(s).toMatch(/^-?\d+(\.\d+)?$/);
                    expect(s).not.toMatch(/\.$/);
                    expect(s.endsWith(".0")).toBe(false);
                },
            ),
            { numRuns: 3000 },
        );
    });
});
