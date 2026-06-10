/**
 * Claim secret generation.
 *
 * The (secret, secretHash) pair is THE redeemable for an L1→L2 fee-juice
 * message — losing the secret after depositing strands the funds, and a wrong
 * secretHash algorithm makes the deposit unclaimable. So we do NOT
 * re-implement the hash: we import `generateClaimSecret` from
 * @aztec/aztec.js@4.3.0 — the exact function the Fizz extension uses
 * (Fr.random() + computeSecretHash = poseidon2 with the protocol's
 * SECRET_HASH domain separator).
 *
 * Imported LAZILY: the aztec.js → bb.js graph includes a multi-MB poseidon2
 * WASM (shipped as a data-url chunk) that must not weigh down page load. It is
 * only fetched when the user actually starts a bridge.
 */

export type ClaimSecretPair = {
    secret: `0x${string}`;
    secretHash: `0x${string}`;
};

export async function generateClaimSecretPair(): Promise<ClaimSecretPair> {
    const { generateClaimSecret } = await import("@aztec/aztec.js/ethereum");
    const [secret, secretHash] = await generateClaimSecret();
    return {
        secret: secret.toString() as `0x${string}`,
        secretHash: secretHash.toString() as `0x${string}`,
    };
}
