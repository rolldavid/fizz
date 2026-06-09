import { describe, expect, it } from "vitest";
import { hasActiveOps, trackOp } from "../../src/lib/state/activity";

/**
 * The idle auto-lock consults hasActiveOps() before firing: a wrong answer
 * either locks mid-transaction (kills an in-flight deploy) or never locks.
 */
describe("activity tracker", () => {
    it("reports active only while the tracked op runs, including failures", async () => {
        expect(hasActiveOps()).toBe(false);

        let resolveOp!: () => void;
        const op = trackOp(() => new Promise<void>((r) => (resolveOp = r)));
        expect(hasActiveOps()).toBe(true);
        resolveOp();
        await op;
        expect(hasActiveOps()).toBe(false);

        await expect(
            trackOp(async () => {
                expect(hasActiveOps()).toBe(true);
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        expect(hasActiveOps()).toBe(false); // released on failure too
    });

    it("stays active until ALL overlapping ops settle", async () => {
        let r1!: () => void, r2!: () => void;
        const p1 = trackOp(() => new Promise<void>((r) => (r1 = r)));
        const p2 = trackOp(() => new Promise<void>((r) => (r2 = r)));
        expect(hasActiveOps()).toBe(true);
        r1();
        await p1;
        expect(hasActiveOps()).toBe(true); // p2 still running
        r2();
        await p2;
        expect(hasActiveOps()).toBe(false);
    });

    it("passes through the op's return value", async () => {
        await expect(trackOp(async () => 42)).resolves.toBe(42);
    });
});
