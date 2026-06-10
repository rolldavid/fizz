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
import { markFeeConsumed, resolveFeePaymentMethod } from "./fee";
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
};

export async function deployToken(input: DeployTokenInput): Promise<DeployTokenResult> {
    const Token = await getTokenContract();

    const { wallet, network, deployer, name, symbol, decimals } = input;

    if (input.initialSupply < 0n) throw new Error("Initial supply cannot be negative.");
    assertWithinU128(input.initialSupply);

    if (!/^[A-Za-z0-9\-_. ]{1,30}$/.test(name)) {
        throw new Error("Name must be 1-30 ASCII characters.");
    }
    if (!/^[A-Z0-9]{1,8}$/.test(symbol)) {
        throw new Error("Symbol must be 1-8 uppercase letters or digits.");
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
        throw new Error("Decimals must be an integer between 0 and 18.");
    }

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

    const instance = await deployTx.getInstance();
    await input.onPredictedAddress?.(instance.address.toString());

    // The default send() waits for mining and resolves to
    // { contract, receipt: { txHash, ... } } (DeployResultMined).
    const sent = await deployTx.send(sendOptions);
    await markFeeConsumed(fee);

    const contract: any = sent.contract;
    const address: AztecAddress | undefined = contract?.address;
    if (!address) throw new Error("Deployment did not return a contract address.");
    const txHash: string = sent.receipt.txHash.toString();

    // Optional initial supply — separate tx so the deploy can be cheap and any
    // mint failure does not destroy the deployment.
    if (input.initialSupply > 0n) {
        const mintFee = await resolveFeePaymentMethod(wallet, network, deployer);
        const mintFn =
            input.initialSupplyMode === "private"
                ? contract.methods.mint_to_private(deployer, input.initialSupply)
                : contract.methods.mint_to_public(deployer, input.initialSupply);
        await mintFn.send({
            from: deployer,
            ...(mintFee.method ? { fee: { paymentMethod: mintFee.method } } : {}),
        } as any);
        await markFeeConsumed(mintFee);
    }

    // Revoke deployer's minter role if the user didn't want to keep it.
    // (set_minter(addr, false) requires admin privileges, which we already have.)
    if (!input.keepMinterRole) {
        const revFee = await resolveFeePaymentMethod(wallet, network, deployer);
        try {
            await contract.methods.set_minter(deployer, false).send({
                from: deployer,
                ...(revFee.method ? { fee: { paymentMethod: revFee.method } } : {}),
            } as any);
            await markFeeConsumed(revFee);
        } catch (e) {
            // Don't fail the whole deploy — the token is already live — but never
            // swallow this silently: the user asked to drop their minter role, so
            // surface it loudly. They can retry revocation from token settings.
            console.warn(
                `Token deployed at ${address.toString()} but revoking the deployer's minter role failed:`,
                e,
            );
        }
    }

    return { address, txHash };
}
