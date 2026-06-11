/**
 * In-browser Aztec wallet wiring.
 *
 * Wraps `@aztec/wallets/embedded` (BrowserEmbeddedWallet), which boots a PXE
 * client backed by IndexedDB and exposes account management on top.
 *
 * The mnemonic seed → Aztec account derivation (DERIVATION_VERSION 1):
 *   - seed = first 32 bytes of the BIP39 seed (see vault/mnemonic.ts)
 *   - secret = SHA-512(seed ‖ "aztec-wallet/v1/account/{i}/secret") reduced into
 *     Fr (BN254 scalar field). This is the account `secret`.
 *   - salt = Fr.ZERO for every account. This matches the Aztec ecosystem default
 *     (the official `aztec-wallet create-account` uses salt 0), which is what
 *     makes accounts RECOVERABLE outside this wallet: exporting the raw `secret`
 *     (see exportAccountSecretHex) and running
 *       aztec-wallet create-account --secret-key <secret>   (salt defaults to 0)
 *     reproduces the exact same address. Distinct accounts differ by `secret`
 *     (via the account index in the domain tag), not by salt.
 *   - `signingKey` defaults to `deriveSigningKey(secret)` inside the SDK.
 *
 * IMPORTANT recovery note: there is no published Aztec "mnemonic → account"
 * standard, so the 12-word phrase alone does NOT restore this account in other
 * wallets — only the wallet-specific KDF above maps phrase→secret. The portable
 * recovery artifact is the raw `secret` hex (+ salt 0). The UI must make that
 * exportable and must not imply the phrase is a universal BIP39 backup.
 *
 * The same mnemonic always yields the same address (deterministic, version-tagged).
 */

import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { Fr } from "@aztec/foundation/curves/bn254";
import { Buffer } from "buffer";
import type { AztecNetwork } from "./networks";

export type AztecWallet = Awaited<ReturnType<typeof EmbeddedWallet.create>>;

async function sha512(bytes: Uint8Array): Promise<Uint8Array> {
    const hash = await globalThis.crypto.subtle.digest("SHA-512", bytes);
    return new Uint8Array(hash);
}

function withDomain(seed: Uint8Array, tag: string): Uint8Array {
    const tagBytes = new TextEncoder().encode(`aztec-wallet/${tag}`);
    const out = new Uint8Array(seed.length + tagBytes.length);
    out.set(seed, 0);
    out.set(tagBytes, seed.length);
    return out;
}

async function deriveFr(seed: Uint8Array, tag: string): Promise<Fr> {
    // `domained` holds a copy of the seed; zero it (and the wide hash, plus the
    // Buffer copy handed to fromBufferReduce) after use so derivation leaves no
    // extra copies of seed-derived material lingering.
    const domained = withDomain(seed, tag);
    const wide = await sha512(domained);
    domained.fill(0);
    const buf = Buffer.from(wide);
    try {
        return Fr.fromBufferReduce(buf);
    } finally {
        wide.fill(0);
        buf.fill(0);
    }
}

/**
 * Bump this only with a migration path — changing it changes every derived
 * address, which is unrecoverable once accounts hold funds.
 */
export const DERIVATION_VERSION = 1;

function secretTag(accountIndex: number): string {
    return `v${DERIVATION_VERSION}/account/${accountIndex}/secret`;
}

export type DerivedAccount = {
    secret: Fr;
    /** Always Fr.ZERO — see the recovery note in this file's header. */
    salt: Fr;
};

export async function deriveAccount(seed: Uint8Array, accountIndex = 0): Promise<DerivedAccount> {
    const secret = await deriveFr(seed, secretTag(accountIndex));
    // salt 0 matches the ecosystem default so the account is reproducible from
    // the raw secret in the official tooling. Do NOT derive the salt from the
    // seed — that was the old behaviour and it made accounts unrecoverable.
    return { secret, salt: Fr.ZERO };
}

/**
 * The portable recovery artifact. Hand this (with salt 0) to any Aztec tool that
 * accepts a raw account secret — e.g. `aztec-wallet create-account --secret-key
 * <hex>` — to reconstruct the exact same address independently of this wallet's
 * KDF. Surface it in an explicit, gated "export account key" UI.
 */
export async function exportAccountSecretHex(seed: Uint8Array, accountIndex = 0): Promise<string> {
    const secret = await deriveFr(seed, secretTag(accountIndex));
    return secret.toString();
}

/**
 * Deterministic bridge-claim secret. Claims used to be RANDOM, which made the
 * extension's local storage the only copy — uninstalling mid-bridge stranded
 * the deposit forever (observed live, real funds). Deriving from the seed
 * means a wallet imported into a fresh browser can re-derive candidate
 * secrets, scan the portal's deposit events for its address, and recover any
 * unclaimed deposit (claimRecovery.ts).
 *
 * PINNED like account derivation (tests/unit/derivation.test.ts): changing
 * this scheme orphans every in-flight claim made under the old one.
 */
export async function deriveBridgeClaimSecret(
    seed: Uint8Array,
    accountIndex: number,
    claimIndex: number,
): Promise<Fr> {
    return deriveFr(
        seed,
        `v${DERIVATION_VERSION}/account/${accountIndex}/bridge-claim/${claimIndex}`,
    );
}

async function checkNodeReachable(nodeUrl: string, timeoutMs = 6000): Promise<void> {
    // Aztec node speaks JSON-RPC. A trivial node_getNodeInfo call confirms the URL
    // is up before we spend time spinning up PXE + WASM.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(nodeUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "node_getNodeInfo", params: [], id: 1 }),
            signal: controller.signal,
        });
        if (!res.ok) {
            throw new Error(`Aztec node at ${nodeUrl} returned HTTP ${res.status}`);
        }
    } catch (err) {
        if ((err as any)?.name === "AbortError") {
            throw new Error(
                `Aztec node at ${nodeUrl} did not respond within ${timeoutMs / 1000}s. ` +
                    `Check the network selector or start your local sandbox.`,
            );
        }
        throw new Error(
            `Cannot reach Aztec node at ${nodeUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
    } finally {
        clearTimeout(timer);
    }
}

export type WalletBootOverrides = {
    /** Default true. Tests against a realProofs:false network may disable. */
    proverEnabled?: boolean;
    /** Default "proven" — see comment below. */
    syncChainTip?: "proposed" | "checkpointed" | "proven" | "finalized";
    /** Default false. True = in-memory stores (tests); never set in the extension. */
    ephemeral?: boolean;
};

export async function createBrowserWallet(
    network: AztecNetwork,
    overrides: WalletBootOverrides = {},
): Promise<AztecWallet> {
    await checkNodeReachable(network.nodeUrl);
    return EmbeddedWallet.create(network.nodeUrl, {
        ...(overrides.ephemeral ? { ephemeral: true } : {}),
        pxeConfig: {
            // Browser proving via bb.js. Heavy but required for true non-custodial UX.
            // With the manifest's COOP/COEP this proves multi-threaded (bb.js gates
            // threads on crossOriginIsolated + SharedArrayBuffer).
            proverEnabled: overrides.proverEnabled ?? true,
            // Sync to the CHECKPOINTED tip: blocks whose checkpoint is published
            // on L1. One notch safer than the SDK default ('proposed', which can
            // reorg within a slot) while staying fresh. We deliberately do NOT
            // use 'proven': on testnet the proven tip lags ~36 blocks (~20 min),
            // which makes a fresh deploy unusable and incoming funds invisible
            // for that long — verified empirically. Residual risk at
            // 'checkpointed': an unproven epoch can in principle be pruned
            // (sequencer gets slashed); rare enough that freshness wins for a
            // wallet. Revisit at mainnet.
            syncChainTip: overrides.syncChainTip ?? "checkpointed",
        },
    });
}

/**
 * Deploy (publish + initialize) an account contract on-chain. A brand-new
 * account exists only inside the PXE until this runs; its first interaction
 * with the network MUST be this deployment — token transfers from an
 * undeployed account fail because the account's entrypoint can't be validated.
 *
 * `feeMethod` is whatever `resolveFeePaymentMethod` produced: a fee-juice
 * bridge claim (the bootstrap path on networks without a sponsored FPC) or a
 * SponsoredFeePaymentMethod. Passing undefined pays from the account's existing
 * fee-juice balance, which a fresh account won't have — callers should resolve
 * a real method first.
 */
export async function deployAccountContract(args: {
    wallet: AztecWallet;
    manager: Awaited<ReturnType<AztecWallet["createSchnorrAccount"]>>;
    feeMethod?: { getExecutionPayload?: unknown } | undefined;
    /**
     * Called the moment the deploy tx is broadcast, BEFORE the inclusion wait.
     * Journal the hash here: if the popup dies during the wait, the next
     * session resumes the SAME tx (settlePriorDeploy) instead of proving a
     * duplicate that the initialization nullifier dooms anyway.
     */
    onBroadcast?: (txHash: string) => Promise<void>;
}): Promise<{ txHash: string }> {
    const { NO_FROM } = await import("@aztec/aztec.js/account");
    const { NO_WAIT } = await import("@aztec/aztec.js/contracts");
    const { waitForTx } = await import("@aztec/aztec.js/node");
    const deployMethod = await args.manager.getDeployMethod();

    // If the account contract CLASS is already published on this chain (true on
    // every public network — account classes ship at genesis), skip publishing
    // it. This keeps the deployment to a SINGLE transaction, which matters when
    // the fee is a one-shot bridge claim: a separate class-publication tx would
    // consume the claim and strand the actual deploy ("No non-nullified L1 to
    // L2 message found" on the second tx — observed empirically).
    const instance = args.manager.getInstance();
    const publishedClass = await (args.wallet as any).aztecNode.getContractClass(
        instance.currentContractClassId,
    );

    // NO_WAIT so the hash exists at broadcast (for the journal); the
    // deployed-ness guarantee this function makes is the waitForTx below.
    const txHash: any = await deployMethod.send({
        from: NO_FROM,
        skipClassPublication: publishedClass != null,
        wait: NO_WAIT,
        ...(args.feeMethod ? { fee: { paymentMethod: args.feeMethod } } : {}),
    } as any);
    if (!txHash) throw new Error("Account deployment sent but returned no tx hash.");
    await args.onBroadcast?.(txHash.toString());

    // Throws on dropped/reverted/timeout — callers must never see "deployed"
    // for an account whose entrypoint doesn't exist on-chain yet.
    await waitForTx((args.wallet as any).aztecNode, txHash);
    return { txHash: txHash.toString() };
}
