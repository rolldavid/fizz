import { beforeEach, describe, expect, it } from "vitest";
import {
    adoptRecoveredBridge,
    dismissBridge,
    listPendingBridges,
    lockClaimForSpend,
    markBridgeConsumed,
    markGasNoticeShown,
    releaseClaimSpendLock,
    type PendingBridge,
} from "../../src/lib/aztec/bridge";
import { secureGet } from "../../src/lib/secureStorage";
import { KEYS } from "../../src/lib/storage";
import { resetChromeStorage } from "../setup/chrome-stub";

const RECIP = "0x" + "00".repeat(31) + "aa";
const SECRET = "0x" + "cd".repeat(32);
const MHASH = "0x" + "ef".repeat(32);

const recoveredEntry = {
    network: "sandbox" as const,
    recipient: RECIP,
    claimAmount: "1000",
    claimSecret: SECRET,
    messageHash: MHASH,
    messageLeafIndex: "1",
};

async function rawBridges(): Promise<PendingBridge[]> {
    return (await secureGet<PendingBridge[]>(KEYS.pendingBridges)) ?? [];
}

describe("bridge: concurrency serialization (withBridgeLock)", () => {
    beforeEach(() => resetChromeStorage());

    it("concurrent mutators never lose a flag (last-writer-wins is fixed)", async () => {
        expect(await adoptRecoveredBridge(recoveredEntry)).toBe(true);
        const id = (await rawBridges())[0].id;

        // Three independent read-modify-write mutators fire at once. Without the
        // serialization latch each would read the same flag-less snapshot and the
        // last secureSet would clobber the other two; the latch forces them to
        // run start-to-finish so all three flags persist.
        await Promise.all([markBridgeConsumed(id), dismissBridge(id), markGasNoticeShown([id])]);

        const entry = (await rawBridges()).find((b) => b.id === id)!;
        expect(entry.consumedAt).toBeTruthy();
        expect(entry.dismissedAt).toBeTruthy();
        expect(entry.noticeShownAt).toBeTruthy();
    });

    it("many interleaved consume calls converge to exactly one consumed entry", async () => {
        expect(await adoptRecoveredBridge(recoveredEntry)).toBe(true);
        const id = (await rawBridges())[0].id;
        await Promise.all(Array.from({ length: 20 }, () => markBridgeConsumed(id)));
        const all = await rawBridges();
        expect(all).toHaveLength(1);
        expect(all[0].consumedAt).toBeTruthy();
    });
});

describe("bridge: recovery dedupe self-heal (HIGH fix)", () => {
    beforeEach(() => resetChromeStorage());

    it("a LIVE duplicate is still deduped (no double-count)", async () => {
        expect(await adoptRecoveredBridge(recoveredEntry)).toBe(true);
        // Same message hash + secret while the first is still live → refused.
        expect(await adoptRecoveredBridge(recoveredEntry)).toBe(false);
        expect(await listPendingBridges("sandbox")).toHaveLength(1);
    });

    it("a wrongly-CONSUMED claim can be re-adopted (recovery resurrects it)", async () => {
        expect(await adoptRecoveredBridge(recoveredEntry)).toBe(true);
        const id = (await rawBridges())[0].id;
        // Simulate a wrong/transient consume (the bug the HIGH fix guards against).
        await markBridgeConsumed(id);
        expect(await listPendingBridges("sandbox")).toHaveLength(0);

        // recoverBridgedClaims only re-adopts messages it proved non-nullified on
        // chain, so the dedupe must ignore consumed entries — otherwise the live
        // claim is stranded forever. Re-adoption must succeed and yield a live entry.
        expect(await adoptRecoveredBridge(recoveredEntry)).toBe(true);
        const live = await listPendingBridges("sandbox");
        expect(live.length).toBe(1);
        expect(live[0].consumedAt).toBeFalsy();
    });

    it("rejects an out-of-u128-range claim amount", async () => {
        await expect(
            adoptRecoveredBridge({ ...recoveredEntry, claimAmount: (1n << 130n).toString() }),
        ).rejects.toThrow();
    });
});

describe("bridge: claim spend lock", () => {
    it("a claim can be locked once; a second lock is refused until released", () => {
        const id = "claim-1";
        expect(lockClaimForSpend(id)).toBe(true);
        expect(lockClaimForSpend(id)).toBe(false); // already held
        releaseClaimSpendLock(id);
        expect(lockClaimForSpend(id)).toBe(true); // re-takeable after release
        releaseClaimSpendLock(id);
    });

    it("locks are independent per claim id", () => {
        expect(lockClaimForSpend("a")).toBe(true);
        expect(lockClaimForSpend("b")).toBe(true);
        expect(lockClaimForSpend("a")).toBe(false);
        releaseClaimSpendLock("a");
        releaseClaimSpendLock("b");
    });
});
