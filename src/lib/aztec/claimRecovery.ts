/**
 * Seed-based bridge-claim recovery.
 *
 * Claim secrets are derived from the recovery phrase (deriveBridgeClaimSecret:
 * seed + account index + a per-account claim counter), so the wallet's local
 * storage is no longer the only copy. A wallet imported into a fresh browser
 * re-derives candidate secrets, pulls the FeeJuicePortal's DepositToAztecPublic
 * events for ITS address from L1 (the `to` arg is indexed, so the query is
 * recipient-filtered), matches each event's secretHash against the candidates,
 * verifies the L1→L2 message is still unclaimed, and re-adopts the claim. The
 * normal lazy path then sweeps it with the first transaction.
 *
 * The scan runs ONCE per (network, account) per install — flagged in local
 * storage on success — plus on demand. It costs a handful of read-only RPC
 * calls: a binary search for the portal's deployment block (getCode) and
 * chunked getLogs from there.
 */

import { createPublicClient, http, parseAbiItem } from "viem";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/foundation/curves/bn254";
import { getNonNullifiedL1ToL2MessageWitness } from "@aztec/stdlib/messaging";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import type { AztecWallet } from "./wallet";
import { deriveBridgeClaimSecret } from "./wallet";
import type { AztecNetwork } from "./networks";
import { adoptRecoveredBridge } from "./bridge";
import { KEYS, storage } from "../storage";
import { secureGet, secureSet } from "../secureStorage";

const lazyHash = () => import("@aztec/stdlib/hash");

const DEPOSIT_EVENT = parseAbiItem(
    "event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
);

// How many claim indices beyond the local counter to derive when matching
// events. Like a BIP-44 gap limit: an imported wallet has counter 0 but may
// have bridged many times before.
const CLAIM_GAP = 64;

// ── per-account claim counter ────────────────────────────────────────────────

function counterKey(networkId: AztecNetwork["id"], account: string): string {
    return `${KEYS.bridgeClaimIndexPrefix}.${networkId}.${account}`;
}

export async function nextClaimIndex(
    networkId: AztecNetwork["id"],
    account: string,
): Promise<number> {
    return (await secureGet<number>(counterKey(networkId, account))) ?? 0;
}

export async function bumpClaimIndex(
    networkId: AztecNetwork["id"],
    account: string,
    used: number,
): Promise<void> {
    const cur = await nextClaimIndex(networkId, account);
    if (used >= cur) await secureSet(counterKey(networkId, account), used + 1);
}

// ── once-per-install flag ────────────────────────────────────────────────────

function doneKey(networkId: AztecNetwork["id"], account: string): string {
    return `${KEYS.bridgeRecoveryDonePrefix}.${networkId}.${account}`;
}
function emptyScanKey(networkId: AztecNetwork["id"], account: string): string {
    return `${KEYS.bridgeRecoveryDonePrefix}.${networkId}.${account}.empty`;
}
// Latch recovery-done only after this many CONSECUTIVE confirmed-empty L1 scans
// (BRIDGE-47): a single [] from a load-balancer backend behind the chain head
// must not permanently disable the auto-scan and strand a real on-chain deposit.
const REQUIRED_EMPTY_SCANS = 2;

export async function isClaimRecoveryDone(
    networkId: AztecNetwork["id"],
    account: string,
): Promise<boolean> {
    return (await storage.get<boolean>(doneKey(networkId, account))) === true;
}

async function markClaimRecoveryDone(
    networkId: AztecNetwork["id"],
    account: string,
): Promise<void> {
    await storage.set(doneKey(networkId, account), true);
}

// ── L1 scan ──────────────────────────────────────────────────────────────────

/** Binary-search the first block where the portal has code (~25 getCode calls). */
async function findDeploymentBlock(client: any, address: `0x${string}`): Promise<bigint> {
    const latest = await client.getBlockNumber();
    const hasCode = async (block: bigint) =>
        ((await client.getCode({ address, blockNumber: block })) ?? "0x") !== "0x";
    if (!(await hasCode(latest))) {
        throw new Error(`FeeJuicePortal ${address} has no code at the L1 tip.`);
    }
    let lo = 0n;
    let hi = latest;
    while (lo < hi) {
        const mid = (lo + hi) / 2n;
        if (await hasCode(mid)) hi = mid;
        else lo = mid + 1n;
    }
    return lo;
}

async function getDepositLogs(
    client: any,
    portal: `0x${string}`,
    recipient: `0x${string}`,
    fromBlock: bigint,
): Promise<any[]> {
    const latest = await client.getBlockNumber();
    const params = { address: portal, event: DEPOSIT_EVENT, args: { to: recipient } };
    try {
        // Most RPCs serve an address+topic-filtered full-range query fine.
        return await client.getLogs({ ...params, fromBlock, toBlock: latest });
    } catch {
        // Range-capped RPC: chunk it.
        const logs: any[] = [];
        const STEP = 50_000n;
        for (let from = fromBlock; from <= latest; from += STEP) {
            const to = from + STEP - 1n > latest ? latest : from + STEP - 1n;
            logs.push(...(await client.getLogs({ ...params, fromBlock: from, toBlock: to })));
        }
        return logs;
    }
}

export type ClaimRecoveryResult = { scanned: number; recovered: number };

/**
 * Recover unclaimed seed-derived bridge claims for one account from L1.
 * Safe to re-run: adoption dedupes on message hash and skips claimed messages.
 */
export async function recoverBridgedClaims(args: {
    wallet: AztecWallet;
    network: AztecNetwork;
    seed: Uint8Array;
    accountIndex: number;
    recipient: AztecAddress;
}): Promise<ClaimRecoveryResult> {
    const { wallet, network, seed, accountIndex, recipient } = args;
    if (!network.l1RpcUrl) return { scanned: 0, recovered: 0 };

    const node = (wallet as any).aztecNode;
    const { l1ContractAddresses } = await node.getNodeInfo();
    const portal = l1ContractAddresses.feeJuicePortalAddress?.toString() as `0x${string}`;
    if (!portal) return { scanned: 0, recovered: 0 };

    const client = createPublicClient({ transport: http(network.l1RpcUrl) });
    const deployedAt = await findDeploymentBlock(client, portal);
    // AztecAddress is a field element — it IS the bytes32 `to` arg.
    const logs = await getDepositLogs(
        client,
        portal,
        recipient.toString() as `0x${string}`,
        deployedAt,
    );
    if (logs.length === 0) {
        // Don't latch done on a SINGLE empty scan — a load balancer behind the
        // chain head returns [] without error, which would permanently disable
        // future scans (autoClaim gates on isClaimRecoveryDone). Require N
        // consecutive confirmed-empty scans first (BRIDGE-47).
        const acct = recipient.toString();
        const empties = ((await storage.get<number>(emptyScanKey(network.id, acct))) ?? 0) + 1;
        if (empties >= REQUIRED_EMPTY_SCANS) {
            await markClaimRecoveryDone(network.id, acct);
        } else {
            await storage.set(emptyScanKey(network.id, acct), empties);
        }
        return { scanned: 0, recovered: 0 };
    }
    // A non-empty scan resets the empty-streak.
    await storage.remove(emptyScanKey(network.id, recipient.toString()));

    // Candidate secrets: indices 0 .. counter+GAP (the counter may be 0 on a
    // fresh import even though many claims exist on-chain).
    const { computeSecretHash } = await lazyHash();
    const top = (await nextClaimIndex(network.id, recipient.toString())) + CLAIM_GAP;
    const byHash = new Map<string, { secret: Fr; index: number }>();
    for (let i = 0; i < top; i++) {
        const secret = await deriveBridgeClaimSecret(seed, accountIndex, i);
        const hash = (await computeSecretHash(secret)).toString().toLowerCase();
        byHash.set(hash, { secret, index: i });
    }

    const feeJuiceAddress = FeeJuiceContract.at(wallet as any).address;
    let recovered = 0;
    let highestIndex = -1;
    for (const log of logs) {
        const hash = String(log.args.secretHash).toLowerCase();
        const match = byHash.get(hash);
        if (!match) continue; // legacy random-secret claim or another wallet's
        highestIndex = Math.max(highestIndex, match.index);
        try {
            // Throws when absent OR already claimed — only live messages adopt,
            // so the optimistic gas display can never overstate.
            await getNonNullifiedL1ToL2MessageWitness(
                node,
                feeJuiceAddress,
                Fr.fromHexString(String(log.args.key)),
                match.secret,
            );
        } catch {
            continue;
        }
        const adopted = await adoptRecoveredBridge({
            network: network.id,
            recipient: recipient.toString(),
            claimAmount: BigInt(log.args.amount).toString(),
            claimSecret: match.secret.toString(),
            messageHash: String(log.args.key),
            messageLeafIndex: BigInt(log.args.index).toString(),
        });
        if (adopted) recovered++;
    }
    // The counter must clear every on-chain claim so new prepares never reuse
    // a spent index (secret reuse would make the deposit unclaimable).
    if (highestIndex >= 0) await bumpClaimIndex(network.id, recipient.toString(), highestIndex);

    await markClaimRecoveryDone(network.id, recipient.toString());
    return { scanned: logs.length, recovered };
}
