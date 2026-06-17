import { type CDPSession, type Page } from "@playwright/test";

/**
 * Attach a CTAP2 virtual authenticator (with PRF support + automatic user
 * verification) to `page`. This makes the wallet's passkey flow run fully
 * automated — navigator.credentials.create/get with the PRF extension (see
 * src/lib/vault/passkey.ts) succeed with no real biometric prompt.
 *
 * Keep the returned CDP session referenced for the authenticator's lifetime;
 * it (and the credential it stores) persists across a same-context page reload,
 * which is what the create → lock → unlock-with-passkey test relies on.
 */
export async function addVirtualAuthenticator(page: Page): Promise<CDPSession> {
    const client = await page.context().newCDPSession(page);
    await client.send("WebAuthn.enable", { enableUI: false });
    await client.send("WebAuthn.addVirtualAuthenticator", {
        options: {
            protocol: "ctap2",
            ctap2Version: "ctap2_1",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            // PRF is mandatory: the wallet derives the vault content key from it.
            hasPrf: true,
            automaticPresenceSimulation: true,
            isUserVerified: true,
        },
    });
    return client;
}
