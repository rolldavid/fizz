import { beforeEach, describe, expect, it } from "vitest";
import { resetChromeStorage } from "../setup/chrome-stub";
import { savePendingConnect, takePendingConnect } from "../../src/lib/state/connections";
import {
    saveBridgeParams,
    readBridgeParams,
} from "../../src/lib/state/bridgeHandoff";
import { routeFromHash } from "../../src/lib/runtime/standalone";

describe("pending connect nonce (AUTH-27)", () => {
    beforeEach(() => resetChromeStorage());

    it("returns the record only for the matching token", async () => {
        await savePendingConnect("https://app.example", "tok-123");
        // Wrong token → rejected (and the record is cleared on read).
        expect(await takePendingConnect("wrong")).toBeNull();
    });

    it("matching token returns and clears the record", async () => {
        await savePendingConnect("https://app.example", "tok-abc");
        const got = await takePendingConnect("tok-abc");
        expect(got?.origin).toBe("https://app.example");
        // Consumed — a second take is null.
        expect(await takePendingConnect("tok-abc")).toBeNull();
    });

    it("a tokenless legacy record is still accepted (back-compat)", async () => {
        await savePendingConnect("https://app.example"); // no token
        const got = await takePendingConnect(undefined);
        expect(got?.origin).toBe("https://app.example");
    });
});

describe("bridge params origin binding (AUTH-26)", () => {
    beforeEach(() => resetChromeStorage());

    it("readBridgeParams carries the bound origin", async () => {
        await saveBridgeParams("https://fizzwallet.com", "0xrecipient", "0xhash");
        const p = await readBridgeParams();
        expect(p?.origin).toBe("https://fizzwallet.com");
        expect(p?.recipient).toBe("0xrecipient");
    });
});

describe("routeFromHash strips a query suffix (AUTH-27 plumbing)", () => {
    it("parses the route from a hash that carries a token", () => {
        expect(routeFromHash("#connect?token=xyz")).toBe("connect");
        expect(routeFromHash("#connect")).toBe("connect");
        expect(routeFromHash("#send")).toBe("send");
        expect(routeFromHash("#bogus")).toBe("home");
    });
});
