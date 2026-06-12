/**
 * Token deployment.
 *
 * Standard pattern follows AIP-20 with constructor `(admin, name, symbol, decimals)`.
 * After deploy, the admin is allowed to mint via `mint_to_public` / `mint_to_private`,
 * so we use it as the recipient of any initial supply when the user provides one.
 *
 * NOTE on Wonderland (`@defi-wonderland/aztec-standards`): the published version
 * targets an older aztec release, but this wallet runs against aztec v4.3.0. The
 * v4 in-tree `@aztec/noir-contracts.js/Token` is the same AIP-20 standard, so we
 * use it here. When Wonderland republishes for v4, swap `getTokenContract()` to
 * import their artifact and the rest of the flow stays the same.
 */

import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecWallet } from "./wallet";
import type { AztecNetwork } from "./networks";
import {
    estimateUiFee,
    feeJuiceFromReceipt,
    markFeeConsumed,
    releaseFee,
    resolveFeePaymentMethod,
    type UiFeeEstimate,
} from "./fee";
import { assertWithinU128, getTokenContract } from "./tokenContract";

export type DeployTokenInput = {
    wallet: AztecWallet;
    network: AztecNetwork;
    deployer: AztecAddress;
    name: string;
    symbol: string;
    decimals: number;
    /** Initial supply in base units. 0n = none. */
    initialSupply: bigint;
    /** Where the initial supply lands. Ignored when `initialSupply === 0n`. */
    initialSupplyMode: "private" | "public";
    /** Whether the deployer keeps mint authority for future supply changes. */
    keepMinterRole: boolean;
    /**
     * Called with the token's address BEFORE the deploy tx is sent. The
     * address is deterministic (DeployMethod caches its instance), so callers
     * can journal it and recover the deploy if this page dies mid-flight.
     */
    onPredictedAddress?: (address: string) => void | Promise<void>;
};

export type DeployTokenResult = {
    address: AztecAddress;
    txHash: string;
    /** Total actual fee across the deploy (+ initial supply / revoke) txs. */
    feeJuice?: bigint;
};

function validateDeployInput(input: DeployTokenInput): void {
    if (input.initialSupply < 0n) throw new Error("Initial supply cannot be negative.");
    assertWithinU128(input.initialSupply);
    if (!/^[A-Za-z0-9\-_. ]{1,30}$/.test(input.name)) {
        throw new Error("Name must be 1-30 ASCII characters.");
    }
    if (!/^[A-Z0-9]{1,8}$/.test(input.symbol)) {
        throw new Error("Symbol must be 1-8 uppercase letters or digits.");
    }
    if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 18) {
        throw new Error("Decimals must be an integer between 0 and 18.");
    }
}

/** Pre-confirm fee estimate for the token-deploy tx (excludes any optional
 *  initial-supply mint / revoke follow-up txs). Best-effort. */
export async function estimateDeployTokenFee(input: DeployTokenInput): Promise<UiFeeEstimate> {
    validateDeployInput(input);
    const Token = await getTokenContract();
    const deployTx = Token.deploy(
        input.wallet as any,
        input.deployer,
        input.name,
        input.symbol,
        input.decimals,
        { deployer: input.deployer },
    );
    return estimateUiFee(input.wallet, input.network, input.deployer, deployTx as any);
}

export async function deployToken(input: DeployTokenInput): Promise<DeployTokenResult> {
    const Token = await getTokenContract();

    const { wallet, network, deployer, name, symbol, decimals } = input;

    validateDeployInput(input);

    const fee = await resolveFeePaymentMethod(wallet, network, deployer);

    // The v4 Token constructor sets `admin = deployer`. Admin can later set/revoke
    // minters; we leave that to the user via a separate Manage screen if needed.
    //
    // The `{ deployer }` instantiation option locks the deployer at
    // construction, which makes the contract address resolvable BEFORE send()
    // — required for the crash journal below. Without it, getInstance() throws
    // "deployer is not yet locked" until send() locks it from the sender; with
    // it, send({ from: deployer }) matches the locked value, so the predicted
    // and deployed addresses always agree.
    const deployTx = Token.deploy(wallet as any, deployer, name, symbol, decimals, { deployer });

    const sendOptions = {
        from: deployer,
        ...(fee.method ? { fee: { paymentMethod: fee.method } } : {}),
    } as any;

    // The default send() waits for mining and resolves to
    // { contract, receipt: { txHash, ... } } (DeployResultMined). getInstance()
    // and the onPredictedAddress journal write are inside the try too, so the
    // fee-claim spend lock taken above is released on ANY failure before mining,
    // not only a send() throw.
    let sent;
    try {
        const instance = await deployTx.getInstance();
        await input.onPredictedAddress?.(instance.address.toString());
        sent = await deployTx.send(sendOptions);
    } catch (err) {
        releaseFee(fee); // claim un-consumed — return it to the pool
        throw err;
    }
    await markFeeConsumed(fee);

    const contract: any = sent.contract;
    const address: AztecAddress | undefined = contract?.address;
    if (!address) throw new Error("Deployment did not return a contract address.");
    const txHash: string = sent.receipt.txHash.toString();

    // Accumulate the ACTUAL fee across all of the deploy's txs for the receipt.
    let totalFee = 0n;
    let haveFee = false;
    const addFee = (f?: bigint) => {
        if (f !== undefined) {
            totalFee += f;
            haveFee = true;
        }
    };
    addFee(feeJuiceFromReceipt(sent));

    // Optional initial supply — separate tx so the deploy can be cheap and any
    // mint failure does not destroy the deployment.
    if (input.initialSupply > 0n) {
        const mintFee = await resolveFeePaymentMethod(wallet, network, deployer);
        const mintFn =
            input.initialSupplyMode === "private"
                ? contract.methods.mint_to_private(deployer, input.initialSupply)
                : contract.methods.mint_to_public(deployer, input.initialSupply);
        let mintSent;
        try {
            mintSent = await mintFn.send({
                from: deployer,
                ...(mintFee.method ? { fee: { paymentMethod: mintFee.method } } : {}),
            } as any);
        } catch (err) {
            releaseFee(mintFee);
            throw err;
        }
        await markFeeConsumed(mintFee);
        addFee(feeJuiceFromReceipt(mintSent));
    }

    // Revoke deployer's minter role if the user didn't want to keep it.
    // (set_minter(addr, false) requires admin privileges, which we already have.)
    if (!input.keepMinterRole) {
        const revFee = await resolveFeePaymentMethod(wallet, network, deployer);
        try {
            const revSent = await contract.methods.set_minter(deployer, false).send({
                from: deployer,
                ...(revFee.method ? { fee: { paymentMethod: revFee.method } } : {}),
            } as any);
            await markFeeConsumed(revFee);
            addFee(feeJuiceFromReceipt(revSent));
        } catch (e) {
            releaseFee(revFee); // claim un-consumed — return it to the pool
            // Don't fail the whole deploy — the token is already live — but never
            // swallow this silently: the user asked to drop their minter role, so
            // surface it loudly. They can retry revocation from token settings.
            console.warn(
                `Token deployed (${address.toString().slice(0, 10)}…) but revoking the deployer's minter role failed:`,
                e,
            );
        }
    }

    // Suppress the actual-fee display when a sponsored FPC paid (the summed
    // receipt fees reflect what the SPONSOR covered, not the user) — keeps the
    // success screen consistent with a pre-confirm "Covered". Sponsored networks
    // sponsor every tx, so the deploy fee's label settles this for all 3.
    const feeJuice = fee.label === "sponsored" ? undefined : haveFee ? totalFee : undefined;
    return { address, txHash, feeJuice };
}
