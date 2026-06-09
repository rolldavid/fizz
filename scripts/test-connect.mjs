/**
 * Connection smoke-test. Mirrors src/lib/state/walletContext.tsx `bootWallet`
 * and src/lib/aztec/wallet.ts `deriveAccount` exactly, but runs under Node so we
 * can validate the SDK <-> node handshake, PXE creation, account derivation and
 * Schnorr account materialization against a live node WITHOUT the browser.
 *
 * Usage:  node scripts/test-connect.mjs [nodeUrl]
 * Default nodeUrl: http://localhost:8080  (the local sandbox)
 *
 * NOTE: under Node the `@aztec/wallets/embedded` import resolves to the *node*
 * entrypoint (LMDB + server PXE) rather than the browser entrypoint (IndexedDB +
 * lazy PXE). The node-reachability, version handshake, derivation math and
 * account creation are identical; only the storage backend differs. A pass here
 * means any remaining browser failure is environment-specific (CSP/WASM/COI),
 * which the manifest now addresses.
 */
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { Fr } from "@aztec/foundation/curves/bn254";
import { mnemonicToSeedSync } from "@scure/bip39";
import { webcrypto } from "node:crypto";

const NODE_URL = process.argv[2] ?? "http://localhost:8080";
const subtle = webcrypto.subtle;

// ---- mirror of src/lib/aztec/wallet.ts -------------------------------------
async function sha512(bytes) {
    return new Uint8Array(await subtle.digest("SHA-512", bytes));
}
function withDomain(seed, tag) {
    const tagBytes = new TextEncoder().encode(`aztec-wallet/${tag}`);
    const out = new Uint8Array(seed.length + tagBytes.length);
    out.set(seed, 0);
    out.set(tagBytes, seed.length);
    return out;
}
async function deriveFr(seed, tag) {
    const wide = await sha512(withDomain(seed, tag));
    return Fr.fromBufferReduce(Buffer.from(wide));
}
async function deriveAccount(seed, accountIndex = 0) {
    // Mirrors src/lib/aztec/wallet.ts (DERIVATION_VERSION 1): versioned secret,
    // salt = Fr.ZERO so the account is reproducible in official tooling.
    const secret = await deriveFr(seed, `v1/account/${accountIndex}/secret`);
    return { secret, salt: Fr.ZERO };
}

const MNEMONIC =
    "test test test test test test test test test test test junk"; // throwaway, deterministic

async function main() {
    console.log(`[1/5] node_getNodeInfo @ ${NODE_URL} ...`);
    const res = await fetch(NODE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "node_getNodeInfo", params: [], id: 1 }),
    });
    const info = await res.json();
    console.log(`      ok: nodeVersion=${info.result?.nodeVersion} l1ChainId=${info.result?.l1ChainId} rollupVersion=${info.result?.rollupVersion} realProofs=${info.result?.realProofs}`);

    console.log(`[2/5] EmbeddedWallet.create (createPXE + getL1ContractAddresses) ...`);
    const t0 = Date.now();
    const wallet = await EmbeddedWallet.create(NODE_URL, {
        ephemeral: true, // in-memory store so we don't litter the FS
        pxeConfig: { proverEnabled: false }, // connection test only; proving is orthogonal
    });
    console.log(`      ok: PXE created in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    console.log(`[3/5] derive account 0 from mnemonic ...`);
    const seed = mnemonicToSeedSync(MNEMONIC).slice(0, 32);
    const { secret, salt } = await deriveAccount(seed, 0);
    console.log(`      ok: secret/salt derived (Fr)`);

    console.log(`[4/5] createSchnorrAccount ...`);
    const accountManager = await wallet.createSchnorrAccount(secret, salt, undefined, "main");
    const address = accountManager.address ?? accountManager.getAddress?.();
    console.log(`      ok: address = ${address}`);

    console.log(`[5/5] getContractMetadata(address) ...`);
    const meta = await wallet.getContractMetadata(address);
    const initStatus = meta.initializationStatus;
    const isDeployed = initStatus === "INITIALIZED"; // matches walletContext.tsx
    console.log(`      ok: initializationStatus=${initStatus} isDeployed=${isDeployed}`);

    console.log(`\n✅ FULL BOOT CHAIN SUCCEEDED against ${NODE_URL}`);
    await wallet.stop?.();
    process.exit(0);
}

main().catch((err) => {
    console.error(`\n❌ BOOT CHAIN FAILED:`, err?.message ?? err);
    console.error(err?.stack?.split("\n").slice(0, 6).join("\n"));
    process.exit(1);
});
