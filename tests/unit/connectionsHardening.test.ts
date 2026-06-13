import { beforeEach, describe, expect, it } from "vitest";
import { resetChromeStorage, chromeStorageSnapshot } from "../setup/chrome-stub";
import {
    isConnected,
    listConnections,
    saveConnection,
    removeConnection,
} from "../../src/lib/state/connections";

const CONNECTIONS_KEY = "fizz.connections.v1";

// connections.ts uses chrome.storage.local directly; seed it via the stub.
async function seedRaw(list: unknown[]): Promise<void> {
    await (globalThis as any).chrome.storage.local.set({ [CONNECTIONS_KEY]: list });
}

describe("connections — per-entry validation (AUTH-24/28, STORAGE-25/26/27)", () => {
    beforeEach(() => resetChromeStorage());

    it("drops null / malformed rows on read and never throws", async () => {
        const now = Date.now();
        await seedRaw([
            null,
            { origin: "https://good.example", approvedAt: now, expiresAt: now + 1e9 },
            { origin: "", approvedAt: now, expiresAt: now + 1e9 }, // empty origin
            { origin: "https://noTimes.example" }, // missing timestamps
            42,
        ]);
        const live = await listConnections();
        expect(live).toHaveLength(1);
        expect(live[0].origin).toBe("https://good.example");
        await expect(isConnected("https://good.example")).resolves.toBe(true);
        await expect(isConnected("https://noTimes.example")).resolves.toBe(false);
    });
});

describe("connections — serialized writes (AUTH-25)", () => {
    beforeEach(() => resetChromeStorage());

    it("a concurrent save(A) and remove(B) both persist", async () => {
        const now = Date.now();
        await seedRaw([{ origin: "https://b.example", approvedAt: now, expiresAt: now + 1e9 }]);
        await Promise.all([
            saveConnection("https://a.example"),
            removeConnection("https://b.example"),
        ]);
        const live = await listConnections();
        const origins = live.map((c) => c.origin);
        expect(origins).toContain("https://a.example");
        expect(origins).not.toContain("https://b.example");
    });
});

describe("connections — cap (STORAGE-14)", () => {
    beforeEach(() => resetChromeStorage());

    it("throws once the live connection cap is reached", async () => {
        for (let i = 0; i < 50; i++) await saveConnection(`https://s${i}.example`);
        await expect(saveConnection("https://overflow.example")).rejects.toThrow(/limit reached/i);
        // Refreshing an EXISTING origin is still allowed at the cap.
        await expect(saveConnection("https://s0.example")).resolves.toBeTruthy();
    });
});

// Sanity that the snapshot helper sees our writes (guards the harness itself).
it("harness: snapshot reflects connection writes", async () => {
    resetChromeStorage();
    await saveConnection("https://x.example");
    expect(chromeStorageSnapshot()[CONNECTIONS_KEY]).toBeTruthy();
});
