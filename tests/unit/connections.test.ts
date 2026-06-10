import { beforeEach, describe, expect, it } from "vitest";
import { resetChromeStorage } from "../setup/chrome-stub";
import {
    isConnected,
    listConnections,
    removeConnection,
    saveConnection,
} from "../../src/lib/state/connections";

const ORIGIN = "https://fizzwallet.com";
const KEY = "fizz.connections.v1";

declare const chrome: any;

describe("connections — address-blind site authorization", () => {
    beforeEach(() => resetChromeStorage());

    it("save → isConnected → list", async () => {
        expect(await isConnected(ORIGIN)).toBe(false);
        const c = await saveConnection(ORIGIN);
        expect(c.origin).toBe(ORIGIN);
        expect(c.expiresAt).toBeGreaterThan(c.approvedAt);
        expect(await isConnected(ORIGIN)).toBe(true);
        expect((await listConnections()).map((x) => x.origin)).toEqual([ORIGIN]);
    });

    it("stores ONLY origin + timestamps — never an address, account, or key", async () => {
        await saveConnection(ORIGIN);
        const [conn] = await listConnections();
        expect(Object.keys(conn).sort()).toEqual(["approvedAt", "expiresAt", "origin"]);
    });

    it("saving the same origin refreshes rather than duplicates", async () => {
        await saveConnection(ORIGIN);
        await saveConnection(ORIGIN);
        expect((await listConnections()).length).toBe(1);
    });

    it("removeConnection revokes the origin", async () => {
        await saveConnection(ORIGIN);
        await removeConnection(ORIGIN);
        expect(await isConnected(ORIGIN)).toBe(false);
    });

    it("expired connections are neither live nor returned, and get pruned", async () => {
        const past = 1000;
        await chrome.storage.local.set({
            [KEY]: [{ origin: ORIGIN, approvedAt: past, expiresAt: past + 1 }],
        });
        expect(await isConnected(ORIGIN)).toBe(false);
        expect(await listConnections()).toEqual([]);
        // listConnections prunes the dead row from storage.
        const raw = await chrome.storage.local.get(KEY);
        expect(raw[KEY]).toEqual([]);
    });

    it("isConnected is strictly per-origin", async () => {
        await saveConnection(ORIGIN);
        expect(await isConnected("https://evil.example")).toBe(false);
    });
});
