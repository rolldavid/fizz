import { describe, expect, it } from "vitest";
import { isToolbarPopup, routeFromHash } from "../../src/lib/runtime/standalone";

describe("standalone-window helpers", () => {
    it("routeFromHash maps known routes and rejects junk", () => {
        expect(routeFromHash("#deploy")).toBe("deploy");
        expect(routeFromHash("#bridge")).toBe("bridge");
        expect(routeFromHash("deploy")).toBe("deploy"); // tolerates missing '#'
        expect(routeFromHash("")).toBe("home");
        expect(routeFromHash("#nope")).toBe("home");
        expect(routeFromHash("#javascript:alert(1)")).toBe("home");
    });

    it("isToolbarPopup is false outside an extension (no chrome.tabs)", async () => {
        // chrome-stub provides storage only — like vitest, like a plain tab.
        await expect(isToolbarPopup()).resolves.toBe(false);
    });
});
