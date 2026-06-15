import { describe, expect, it } from "vitest";
import { ACCOUNT_DISCOVERY_GAP_LIMIT, discoverAccountCount } from "../../src/lib/aztec/wallet";

/**
 * Account discovery on restore (INVARIANT LIFECYCLE-36). `discoverAccountCount`
 * is the pure gap-limit scan that decides how many accounts a freshly imported
 * seed already owns on-chain. These cases pin its correctness, its boundedness
 * (a node that always answers "deployed" cannot drive an unbounded scan), and
 * its keep-index-0 guarantee (a never-deployed import still lands on account 0).
 *
 * MAX_ACCOUNTS in walletContext is 16; the scan is always passed that cap.
 */
const MAX = 16;

/** A probe reporting the given indices as deployed, recording every call. */
function probeFor(deployed: Iterable<number>) {
    const set = new Set(deployed);
    const calls: number[] = [];
    const isDeployed = async (i: number) => {
        calls.push(i);
        return set.has(i);
    };
    return { isDeployed, calls };
}

describe("discoverAccountCount — gap-limit scan (LIFECYCLE-36)", () => {
    it("default gap limit is 5", () => {
        expect(ACCOUNT_DISCOVERY_GAP_LIMIT).toBe(5);
    });

    it("only account 0 deployed → count 1, scan stops after one gap run", async () => {
        const { isDeployed, calls } = probeFor([0]);
        await expect(discoverAccountCount(isDeployed, MAX)).resolves.toBe(1);
        // Probes 0 (deployed) then 1..5 (5 undeployed = the gap limit), then stops.
        expect(calls).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("contiguous accounts 0..3 deployed → count 4", async () => {
        const { isDeployed } = probeFor([0, 1, 2, 3]);
        await expect(discoverAccountCount(isDeployed, MAX)).resolves.toBe(4);
    });

    it("tolerates a single undeployed hole (0 and 2 deployed, 1 not) → count 3", async () => {
        const { isDeployed } = probeFor([0, 2]);
        await expect(discoverAccountCount(isDeployed, MAX)).resolves.toBe(3);
    });

    it("tolerates a hole smaller than the gap limit (0 and 3 deployed) → count 4", async () => {
        const { isDeployed } = probeFor([0, 3]);
        await expect(discoverAccountCount(isDeployed, MAX)).resolves.toBe(4);
    });

    it("never-deployed fresh import → count 1 (index 0 always kept)", async () => {
        const { isDeployed, calls } = probeFor([]);
        await expect(discoverAccountCount(isDeployed, MAX)).resolves.toBe(1);
        // Stops after exactly gapLimit undeployed probes (indices 0..4).
        expect(calls).toEqual([0, 1, 2, 3, 4]);
    });

    it("a deployed account beyond a full gap is NOT found (documented boundary)", async () => {
        // A gap of >= gapLimit hides later accounts. Accounts are contiguous in
        // practice, so this only arises from a malicious node or corrupted state.
        const { isDeployed, calls } = probeFor([0, 10]);
        await expect(discoverAccountCount(isDeployed, MAX)).resolves.toBe(1);
        expect(calls).not.toContain(10);
    });

    it("is bounded by maxAccounts even if the node says every index is deployed", async () => {
        const calls: number[] = [];
        const alwaysDeployed = async (i: number) => {
            calls.push(i);
            return true;
        };
        await expect(discoverAccountCount(alwaysDeployed, MAX)).resolves.toBe(MAX);
        expect(calls).toHaveLength(MAX); // terminates — no unbounded scan (S1/S12)
    });

    it("honours a custom gap limit", async () => {
        // With gapLimit 2, the hole between 0 and 3 (size 2) is NOT tolerated.
        const tight = probeFor([0, 3]);
        await expect(discoverAccountCount(tight.isDeployed, MAX, 2)).resolves.toBe(1);
        // Same deployment under the default gapLimit 5 recovers account 3.
        const loose = probeFor([0, 3]);
        await expect(discoverAccountCount(loose.isDeployed, MAX)).resolves.toBe(4);
    });

    it("propagates a probe error rather than persisting a partial count", async () => {
        const boom = async (i: number) => {
            if (i === 2) throw new Error("node unreachable");
            return true;
        };
        await expect(discoverAccountCount(boom, MAX)).rejects.toThrow(/node unreachable/);
    });

    it("rejects a non-positive maxAccounts", async () => {
        await expect(discoverAccountCount(async () => false, 0)).rejects.toThrow(/positive integer/);
        await expect(discoverAccountCount(async () => false, 1.5)).rejects.toThrow(/positive integer/);
    });
});
