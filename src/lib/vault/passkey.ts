/**
 * WebAuthn passkey + PRF extension.
 *
 * The PRF extension lets us deterministically derive a 32-byte secret from a
 * registered passkey + a salt we supply. We use that 32-byte output as the
 * vault's AES content key. The authenticator never reveals it without a user
 * gesture (Touch ID / Face ID / security key tap), so the vault is gated on
 * physical presence and biometric/PIN, not a remembered passphrase.
 *
 * If the authenticator does NOT support the PRF extension, registration throws
 * and the UI falls back to the passphrase path.
 */

import { b64 } from "./crypto";

const RP_NAME = "Aztec Wallet";

// We deliberately DO NOT set an explicit RP ID. In a chrome-extension:// popup
// the only valid RP ID is the extension's own origin; if we passed a literal
// string (the old code fell back to "aztec-wallet", which is not a valid domain)
// or read it from `location.hostname`, the value used at registration could
// diverge from the value used at assertion and permanently brick unlock. By
// omitting `rp.id` on create and `rpId` on get, the browser defaults both to the
// same extension origin — stable for the life of the install — so register and
// assert can never disagree.

function randomBytes(length: number): Uint8Array {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export type PasskeyRegistration = {
    credentialId: string; // base64
    prfSalt: string; // base64
    contentKey: Uint8Array; // 32 bytes — caller must wipe after use
};

export async function registerPasskey(userLabel: string): Promise<PasskeyRegistration> {
    if (!("credentials" in navigator)) {
        throw new Error("WebAuthn is not available in this browser.");
    }

    const userId = randomBytes(16);
    const prfSalt = randomBytes(32);
    const challenge = randomBytes(32);

    const cred = (await navigator.credentials.create({
        publicKey: {
            challenge,
            rp: { name: RP_NAME }, // id omitted — defaults to the extension origin
            user: {
                id: userId,
                name: userLabel,
                displayName: userLabel,
            },
            pubKeyCredParams: [
                { type: "public-key", alg: -7 }, // ES256
                { type: "public-key", alg: -257 }, // RS256
            ],
            authenticatorSelection: {
                residentKey: "required",
                userVerification: "required",
            },
            extensions: {
                // @ts-expect-error PRF extension not yet in TS lib
                prf: { eval: { first: prfSalt } },
            },
            timeout: 60_000,
        },
    })) as PublicKeyCredential | null;

    if (!cred) throw new Error("Passkey registration was cancelled.");

    const ext = cred.getClientExtensionResults() as {
        prf?: { results?: { first?: ArrayBuffer } };
    };
    const prfOutput = ext.prf?.results?.first;
    if (!prfOutput) {
        throw new Error(
            "This authenticator does not support the PRF extension. Use the 12-word phrase instead.",
        );
    }

    return {
        credentialId: b64.encode(cred.rawId),
        prfSalt: b64.encode(prfSalt),
        contentKey: new Uint8Array(prfOutput),
    };
}

export async function unlockWithPasskey(
    credentialIdB64: string,
    prfSaltB64: string,
): Promise<Uint8Array> {
    const credentialId = b64.decode(credentialIdB64);
    const prfSalt = b64.decode(prfSaltB64);
    const challenge = randomBytes(32);

    const assertion = (await navigator.credentials.get({
        publicKey: {
            challenge,
            // rpId omitted — defaults to the same extension origin used at register
            allowCredentials: [{ type: "public-key", id: credentialId }],
            userVerification: "required",
            extensions: {
                // @ts-expect-error PRF extension not yet in TS lib
                prf: { eval: { first: prfSalt } },
            },
            timeout: 60_000,
        },
    })) as PublicKeyCredential | null;

    if (!assertion) throw new Error("Passkey unlock was cancelled.");

    const ext = assertion.getClientExtensionResults() as {
        prf?: { results?: { first?: ArrayBuffer } };
    };
    const prfOutput = ext.prf?.results?.first;
    if (!prfOutput) {
        throw new Error("Authenticator did not return a PRF output. Cannot unlock vault.");
    }
    return new Uint8Array(prfOutput);
}
