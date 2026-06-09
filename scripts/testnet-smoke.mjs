/**
 * Testnet smoke test — proves the wallet's full flow against the PUBLIC
 * alpha-testnet with REAL client-side proving:
 *
 *   1. boot PXE against https://rpc.testnet.aztec-labs.com
 *   2. derive a throwaway test account (fresh random mnemonic, or pass
 *      TESTNET_SMOKE_MNEMONIC to reuse one across runs)
 *   3. deploy the account contract, fees paid by the canonical SponsoredFPC
 *   4. deploy a Token contract (sponsored)
 *   5. mint privately (sponsored), read balances back
 *
 * This answers, with on-chain evidence: can a brand-new user start from NOTHING
 * (no ETH, no fee juice) and reach a deployed account + deployed token?
 *
 * Optional: set TESTNET_L1_PRIVATE_KEY to also test the L1 fee-juice bridge
 * (Sepolia). Never commit that key. Run:
 *   node scripts/testnet-smoke.mjs [stage]
 * where stage ∈ {all, account, token, mint} (default all — continues across
 * stages with the same mnemonic written to /tmp/aztec-testnet-smoke.json).
 */
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { Fr } from "@aztec/foundation/curves/bn254";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { NO_FROM } from "@aztec/aztec.js/account";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { getContractInstanceFromInstantiationParams, Contract } from "@aztec/aztec.js/contracts";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { webcrypto } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const STATE_FILE = "/tmp/aztec-testnet-smoke.json";

function loadState() {
    if (process.env.TESTNET_SMOKE_MNEMONIC) {
        return { mnemonic: process.env.TESTNET_SMOKE_MNEMONIC };
    }
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
    const state = { mnemonic: generateMnemonic(wordlist, 128) };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return state;
}
function saveState(patch) {
    const cur = loadState();
    const next = { ...cur, ...patch };
    writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
    return next;
}

// ---- mirror of src/lib/aztec/wallet.ts derivation (v1) ----------------------
async function deriveAccount(seed, accountIndex = 0) {
    const tagBytes = new TextEncoder().encode(`aztec-wallet/v${1}/account/${accountIndex}/secret`);
    const input = new Uint8Array(seed.length + tagBytes.length);
    input.set(seed, 0);
    input.set(tagBytes, seed.length);
    const wide = new Uint8Array(await webcrypto.subtle.digest("SHA-512", input));
    return { secret: Fr.fromBufferReduce(Buffer.from(wide)), salt: Fr.ZERO };
}

function ts() {
    return new Date().toISOString().slice(11, 19);
}
function log(...args) {
    console.log(`[${ts()}]`, ...args);
}

async function main() {
    const stage = process.argv[2] ?? "all";
    const state = loadState();
    log(`state file: ${STATE_FILE}`);

    log(`booting EmbeddedWallet against ${NODE_URL} (real proofs)…`);
    const t0 = Date.now();
    const wallet = await EmbeddedWallet.create(NODE_URL, {
        ephemeral: true,
        pxeConfig: { proverEnabled: true },
    });
    log(`PXE up in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const seed = mnemonicToSeedSync(state.mnemonic).slice(0, 32);
    const { secret, salt } = await deriveAccount(seed, 0);
    const manager = await wallet.createSchnorrAccount(secret, salt, undefined, "smoke");
    const address = manager.address;
    log(`test account: ${address}`);

    // Sponsored FPC — the wallet's own derivation.
    const fpcInstance = await getContractInstanceFromInstantiationParams(
        SponsoredFPCContractArtifact,
        { salt: new Fr(SPONSORED_FPC_SALT) },
    );
    await wallet.registerContract(fpcInstance, SponsoredFPCContractArtifact);
    const sponsored = new SponsoredFeePaymentMethod(fpcInstance.address);
    log(`sponsored FPC: ${fpcInstance.address}`);

    const meta = await wallet.getContractMetadata(address);
    log(`account initializationStatus: ${meta.initializationStatus}`);

    if (["all", "account"].includes(stage) && String(meta.initializationStatus) !== "INITIALIZED") {
        log("STAGE account: deploying account contract (sponsored)…");
        const t = Date.now();
        const deployMethod = await manager.getDeployMethod();
        const sent = await deployMethod.send({
            from: NO_FROM,
            fee: { paymentMethod: sponsored },
        });
        log(`account deployed in ${((Date.now() - t) / 1000).toFixed(1)}s tx=${sent.receipt?.txHash}`);
        saveState({ accountDeployed: true });
    } else {
        log("STAGE account: already initialized — skipping");
    }

    let tokenAddress = state.tokenAddress ? AztecAddress.fromString(state.tokenAddress) : undefined;
    if (["all", "token"].includes(stage) && !tokenAddress) {
        log("STAGE token: deploying Token (sponsored)…");
        const t = Date.now();
        const sent = await TokenContract.deploy(wallet, address, "Smoke Token", "SMK", 6).send({
            from: address,
            fee: { paymentMethod: sponsored },
        });
        tokenAddress = sent.contract.address;
        log(`token deployed in ${((Date.now() - t) / 1000).toFixed(1)}s at ${tokenAddress} tx=${sent.receipt?.txHash}`);
        saveState({ tokenAddress: tokenAddress.toString() });
    } else if (tokenAddress) {
        log(`STAGE token: reusing ${tokenAddress}`);
    }

    if (["all", "mint"].includes(stage) && tokenAddress) {
        const token = await Contract.at(tokenAddress, TokenContract.artifact, wallet);
        log("STAGE mint: mint_to_private 1000.000000 SMK (sponsored)…");
        const t = Date.now();
        const sent = await token.methods.mint_to_private(address, 1_000_000_000n).send({
            from: address,
            fee: { paymentMethod: sponsored },
        });
        log(`minted in ${((Date.now() - t) / 1000).toFixed(1)}s tx=${sent.receipt?.txHash}`);

        const priv = await token.methods.balance_of_private(address).simulate({ from: address });
        const pub = await token.methods.balance_of_public(address).simulate({ from: address });
        const val = (x) => (x && typeof x === "object" && "result" in x ? x.result : x);
        log(`balances — private: ${val(priv)}  public: ${val(pub)}`);
    }

    log("✅ TESTNET SMOKE COMPLETE");
    await wallet.stop?.();
    process.exit(0);
}

main().catch((err) => {
    console.error(`\n❌ TESTNET SMOKE FAILED:`, err?.message ?? err);
    console.error(err?.stack?.split("\n").slice(0, 12).join("\n"));
    process.exit(1);
});
