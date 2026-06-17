import { test, expect } from "../fixtures";
import { addVirtualAuthenticator } from "../webauthn";
import { OnboardingPage } from "../pages/onboarding.page";
import { postAuthScreen } from "../flows";
import { NEUTRALIZE_DECORATION_CSS } from "../constants";

/**
 * Passkey lifecycle via a WebAuthn virtual authenticator (PRF-enabled): create a
 * wallet secured with a passkey, lock it, and unlock with the passkey — no real
 * biometric prompt. This exercises the same passkey path real users use; it's
 * LOCAL (no network), using a freshly generated wallet.
 *
 * Note: a passkey's PRF-derived key is authenticator-bound, so this can't reuse
 * a real device passkey — funded wallets are reached via mnemonic import instead.
 */
test.describe("passkey unlock (WebAuthn virtual authenticator)", () => {
    test.describe.configure({ timeout: 180_000 });

    test("create with a passkey, lock, and unlock with the passkey", async ({ popup }) => {
        await addVirtualAuthenticator(popup);

        const o = new OnboardingPage(popup);
        await o.expectIntro();
        await o.createBtn.click();
        // Choose the passkey method → advances to the recovery-words step.
        await o.usePasskeyBtn.click();
        await expect(o.words).toHaveCount(12);
        // Finalize: registers the passkey (credentials.create + PRF) + creates vault.
        await popup.getByRole("button", { name: /I've saved it/ }).click();
        await expect(postAuthScreen(popup)).toBeVisible({ timeout: 60_000 });

        // Lock, then reload for a quiet lock screen (same context → the virtual
        // authenticator and its credential persist across the reload).
        const cancel = popup.getByRole("button", { name: "Cancel and lock" });
        const lock = popup.getByRole("button", { name: "Lock wallet" });
        await expect(cancel.or(lock)).toBeVisible({ timeout: 60_000 });
        if (await cancel.isVisible()) await cancel.click();
        else await lock.click();
        await popup.waitForTimeout(1500);
        await popup.reload({ waitUntil: "domcontentloaded" });
        await popup.addStyleTag({ content: NEUTRALIZE_DECORATION_CSS });

        // The lock screen offers the passkey method (vault method === "passkey").
        const unlockWithPasskey = popup.getByRole("button", { name: "Unlock with passkey" });
        await expect(unlockWithPasskey).toBeVisible({ timeout: 30_000 });
        await unlockWithPasskey.click();
        // The virtual authenticator auto-satisfies the assertion → PRF → unlock.
        await expect(postAuthScreen(popup)).toBeVisible({ timeout: 60_000 });
    });
});
