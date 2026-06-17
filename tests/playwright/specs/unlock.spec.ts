import { test, expect } from "../fixtures";
import { UnlockPage } from "../pages/unlock.page";
import { createThenLock, postAuthScreen } from "../flows";
import { TEST_PASSPHRASE } from "../constants";

/**
 * Lock / unlock lifecycle. LOCAL — Argon2id verification runs in-extension; a
 * wrong passphrase is rejected without any node contact, and a correct one
 * hands off to the PXE boot.
 */
test.describe("unlock", () => {
    // Heavy KDF: each unlock runs Argon2id (128 MiB, t=3); a WRONG passphrase
    // pays it TWICE (primary + legacy-KDF fallback) plus an anti-brute-force
    // backoff before it reports failure. Budget the whole describe accordingly.
    test.describe.configure({ timeout: 240_000 });

    test("locking the wallet shows the unlock screen", async ({ popup }) => {
        await createThenLock(popup);
        await new UnlockPage(popup).expectLocked();
    });

    test("a wrong passphrase is rejected with a visible error", async ({ popup }) => {
        await createThenLock(popup);
        const u = new UnlockPage(popup);
        await u.unlock("definitely-not-the-right-passphrase");
        // After the unlock-flow fix, the error surfaces ON the lock screen — no
        // silent reset and no misleading "Connecting…" flash. The KDF runs twice
        // on failure, so allow generous time.
        await expect(u.error).toBeVisible({ timeout: 90_000 });
        await expect(u.heading).toBeVisible(); // still locked
        await expect(u.unlockBtn).toBeVisible();
    });

    test("the correct passphrase unlocks and re-enters the PXE boot", async ({ popup }) => {
        await createThenLock(popup);
        const u = new UnlockPage(popup);
        await u.unlock(TEST_PASSPHRASE);
        await expect(postAuthScreen(popup)).toBeVisible({ timeout: 30_000 });
    });

    test("'Forget wallet' is guarded by a confirm dialog (dismiss keeps it)", async ({
        popup,
    }) => {
        await createThenLock(popup);
        const u = new UnlockPage(popup);
        // The destructive wipe is gated behind window.confirm — dismiss it and
        // the wallet must remain intact (still locked, not wiped to onboarding).
        popup.on("dialog", (d) => d.dismiss());
        await u.forgetBtn.click();
        await u.expectLocked();
    });
});
