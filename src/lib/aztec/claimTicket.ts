/**
 * Fee-juice claim ticket — the hand-off format between the public bridge page
 * (fizzwallet.com/bridge) and the extension.
 *
 * A FeeJuicePortal deposit produces an L1→L2 message redeemable ONLY with
 * (recipient, amount, secret, leaf index). When the deposit happens outside
 * the extension (user's own L1 wallet via RainbowKit), the wallet must learn
 * those values to auto-pay a future tx with the claim. The page hands them
 * over as a ticket: via chrome.runtime.sendMessage when the extension is
 * installed, or as copy-paste text otherwise.
 *
 * Tickets contain NO spending power over anything except triggering this one
 * claim — the recipient is fixed inside the L1→L2 message itself, so a leaked
 * ticket can at worst claim the fee juice FOR its intended recipient.
 *
 * ZERO-dependency module by design: the bridge web app imports it directly
 * (vite alias) without dragging aztec.js into its bundle.
 */

export type ClaimTicket = {
    v: 1;
    kind: "fee-juice-claim";
    /** Friendly network id the deposit targeted (as the bridge page saw it). */
    networkId: string;
    /** L1 chain the deposit happened on — sanity-checked at import. */
    l1ChainId: number;
    /** Aztec address the message credits — fixed on L1, not changeable here. */
    recipient: string;
    claimAmount: string; // bigint as string
    claimSecret: string; // hex field element
    messageHash: string; // hex
    messageLeafIndex: string; // bigint as string
    /** Provenance for support/debugging. */
    l1TxHash: string;
    createdAt: number;
};

const PREFIX = "fizzclaim1:";
const HEX = /^0x[0-9a-fA-F]+$/;
const DECIMAL = /^\d+$/;

export function validateClaimTicket(t: unknown): ClaimTicket {
    const x = t as Record<string, unknown>;
    if (!x || typeof x !== "object") throw new Error("Claim ticket: not an object.");
    if (x.v !== 1) throw new Error(`Claim ticket: unsupported version ${String(x.v)}.`);
    if (x.kind !== "fee-juice-claim") throw new Error("Claim ticket: wrong kind.");
    if (typeof x.networkId !== "string" || !x.networkId) throw new Error("Claim ticket: missing networkId.");
    if (typeof x.l1ChainId !== "number" || !Number.isInteger(x.l1ChainId)) {
        throw new Error("Claim ticket: bad l1ChainId.");
    }
    for (const f of ["recipient", "claimSecret", "messageHash", "l1TxHash"] as const) {
        if (typeof x[f] !== "string" || !HEX.test(x[f] as string)) {
            throw new Error(`Claim ticket: ${f} must be 0x-hex.`);
        }
    }
    for (const f of ["claimAmount", "messageLeafIndex"] as const) {
        if (typeof x[f] !== "string" || !DECIMAL.test(x[f] as string)) {
            throw new Error(`Claim ticket: ${f} must be a decimal string.`);
        }
    }
    if (typeof x.createdAt !== "number") throw new Error("Claim ticket: missing createdAt.");
    return x as unknown as ClaimTicket;
}

/** Compact copy-paste form: prefix + base64url(JSON). */
export function encodeClaimTicket(ticket: ClaimTicket): string {
    const json = JSON.stringify(validateClaimTicket(ticket));
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return PREFIX + b64;
}

export function decodeClaimTicket(text: string): ClaimTicket {
    const trimmed = text.trim();
    if (!trimmed.startsWith(PREFIX)) {
        throw new Error(`Not a Fizz claim ticket (expected it to start with "${PREFIX}").`);
    }
    const b64 = trimmed.slice(PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    let json: string;
    try {
        json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    } catch {
        throw new Error("Claim ticket: corrupted encoding.");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new Error("Claim ticket: corrupted contents.");
    }
    return validateClaimTicket(parsed);
}
