import { describe, it, expect } from "vitest";
import { withPxeLock } from "../../src/lib/aztec/pxeLock";
import { hasActiveOps } from "../../src/lib/state/activity";

/**
 * The lock exists to guarantee that two high-level PXE operations never
 * interleave their awaits — that interleaving is what opens the kv-store's
 * "transaction has finished" race. These tests pin the guarantee:
 *  1. operations run strictly one-at-a-time (no overlap), in submission order;
 *  2. a thrown operation never wedges the queue;
 *  3. the activity counter is raised while an op runs and cleared after.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("withPxeLock", () => {
    it("serializes concurrent operations with no overlap", async () => {
        let running = 0;
        let maxConcurrent = 0;
        const order: number[] = [];

        const op = (id: number) =>
            withPxeLock(async () => {
                running++;
                maxConcurrent = Math.max(maxConcurrent, running);
                // Yield several times so a non-serialized impl would interleave here.
                await tick();
                await tick();
                order.push(id);
                running--;
                return id;
            });

        // Fire all at once — the lock must run them sequentially.
        const results = await Promise.all([op(1), op(2), op(3), op(4), op(5)]);

        expect(maxConcurrent).toBe(1); // never two at once
        expect(order).toEqual([1, 2, 3, 4, 5]); // FIFO submission order
        expect(results).toEqual([1, 2, 3, 4, 5]); // each gets its own result
    });

    it("returns the operation's resolved value", async () => {
        await expect(withPxeLock(async () => 42)).resolves.toBe(42);
    });

    it("propagates a thrown error to that caller without wedging the queue", async () => {
        const boom = withPxeLock(async () => {
            throw new Error("boom");
        });
        await expect(boom).rejects.toThrow("boom");

        // The next op must still run after a failure ahead of it.
        const order: string[] = [];
        const a = withPxeLock(async () => {
            await tick();
            order.push("a");
        });
        const b = withPxeLock(async () => {
            order.push("b");
        });
        await Promise.all([a, b]);
        expect(order).toEqual(["a", "b"]);
    });

    it("keeps a failing op from overlapping the next one", async () => {
        let running = 0;
        let maxConcurrent = 0;
        const guarded = (fail: boolean) =>
            withPxeLock(async () => {
                running++;
                maxConcurrent = Math.max(maxConcurrent, running);
                await tick();
                running--;
                if (fail) throw new Error("x");
            }).catch(() => {});
        await Promise.all([guarded(true), guarded(false), guarded(true)]);
        expect(maxConcurrent).toBe(1);
    });

    it("marks the op active while running and clears it after", async () => {
        expect(hasActiveOps()).toBe(false);
        let sawActiveInside = false;
        await withPxeLock(async () => {
            sawActiveInside = hasActiveOps();
            await tick();
        });
        expect(sawActiveInside).toBe(true);
        expect(hasActiveOps()).toBe(false);
    });
});
