/**
 * Incoming-transfer discovery for the local history view.
 *
 * ONLY private incoming is detectable. The v4 Token emits its `Transfer` event
 * only from the private `transfer` fn, delivered (encrypted) to the
 * recipient — discoverable via getPrivateEvents, and ONLY when the sender is a
 * registered sender (a contact / an address you've sent to). `transfer_in_public`
 * emits NO event at all (it just mutates public_balances), so there is nothing
 * on-chain to find for a public receipt — public incoming is intentionally not
 * shown (the UI says so). Unknown-sender private receipts also won't appear.
 *
 * COST BOUND: scanning from genesis on mainnet is infeasible, so the first run
 * just plants the cursor at the chain tip and scans nothing (incoming before the
 * user first opened history is intentionally not back-filled — surfaced in copy).
 * Subsequent runs scan only the new span, capped to MAX_SPAN with a LOUD warn
 * (no silent truncation).
 *
 * BEST-EFFORT: like the rest of tx-history this is convenience, so one token
 * failing must not abort the others, and the whole scan must never throw into
 * the history screen. Failures warn via describeError. Addresses are never
 * logged (security-audited wallet) — see `redact`.
 *
 * SERIALIZATION: the entire body runs under withPxeLock because it queries the
 * PXE (the private-event read), and the mainnet RPC is load-balanced so
 * concurrent PXE access fails. The lock is acquired ONCE here at the top-level
 * entry, never nested inside a function a locked op already calls.
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { BlockNumber } from "@aztec/foundation/branded-types";
import type { AztecWallet } from "./wallet";
import type { AztecNetwork } from "./networks";
import { loadTokens } from "./tokens";
import { getTokenContract } from "./tokenContract";
import { withPxeLock } from "./pxeLock";
import { getScanCursor, recordEntry, setScanCursor } from "./txHistory";
import { describeError } from "../errors";

const redact = (a: string): string => (a.length > 12 ? `${a.slice(0, 10)}…` : a);

/** Never scan more than this many blocks of incoming history in one pass. */
const MAX_SPAN = 20000;

/** Normalize a decoded address-like value to its canonical 0x string. */
function addrStr(v: { toString(): string }): string {
    return AztecAddress.fromString(v.toString()).toString();
}

/**
 * Scan for incoming transfers to `account` since the last cursor and record
 * them. Returns the count of newly recorded incoming entries.
 *
 * Best-effort end to end — resolves even if the scan partially or fully fails.
 */
export async function scanIncoming(
    wallet: AztecWallet,
    network: AztecNetwork,
    account: string,
): Promise<number> {
    return withPxeLock(async () => {
        try {
            const node = (wallet as any).aztecNode;
            const Token = await getTokenContract();
            const tokens = (await loadTokens(network.id, account)).filter(
                (t) => t.kind === "token",
            );
            if (tokens.length === 0) return 0;

            const latest: number = await node.getBlockNumber();

            const cursor = await getScanCursor(network.id, account);
            if (cursor === null) {
                // First run: track forward only. Older incoming (before history
                // was first opened) is intentionally NOT back-filled — scanning
                // from genesis on mainnet is infeasible. Surfaced in the UI copy.
                await setScanCursor(network.id, account, latest);
                return 0;
            }

            let fromBlock = cursor + 1;
            if (fromBlock > latest) return 0; // nothing new since last scan

            if (latest - fromBlock > MAX_SPAN) {
                const skipped = latest - fromBlock - MAX_SPAN;
                // LOUD: we are not silently dropping this history — tell the
                // console how much incoming we skipped because the span was
                // capped (the user can't have been waiting long enough for this
                // to be reachable in a single pass anyway).
                console.warn(
                    `tx-history: skipped ~${skipped} blocks of incoming history (scan span capped at ${MAX_SPAN})`,
                );
                fromBlock = latest - MAX_SPAN;
            }
            const toBlock = latest + 1; // exclusive upper bound per the SDK

            const from = BlockNumber(fromBlock);
            const to = BlockNumber(toBlock);

            type RawEvent = {
                event: { from: { toString(): string }; to: { toString(): string }; amount: bigint | number };
                metadata: { txHash?: { toString(): string } };
            };
            const toEntry = (ev: RawEvent, token: string, i: number) => {
                const toAddr = addrStr(ev.event.to);
                const fromAddr = addrStr(ev.event.from);
                if (toAddr !== account || fromAddr === account) return null; // incoming only
                const txHash = ev.metadata.txHash?.toString();
                return {
                    // logIndex is not exposed per-event; the array index within
                    // (txHash, token) is a stable dedupe key.
                    id: `${txHash}:${token}:${i}`,
                    kind: "transfer" as const,
                    direction: "in" as const,
                    privacy: "private" as const,
                    counterparty: fromAddr,
                    tokenAddress: token,
                    amount: BigInt(ev.event.amount).toString(),
                    txHash,
                    // No per-block wall clock is available here, so we use scan
                    // time. Ordering against outgoing (also Date.now at send)
                    // stays roughly correct; this is a local view.
                    at: Date.now(),
                };
            };

            // Collect first, then persist sequentially. recordEntry does a
            // read-modify-write of one storage key, so firing many concurrently
            // would race and lose entries — sequential awaits keep them all.
            const pending: NonNullable<ReturnType<typeof toEntry>>[] = [];
            // Only advance the cursor past this span if EVERY token scanned
            // cleanly. On the load-balanced mainnet RPC a transient read failure
            // is common; advancing regardless would permanently skip that token's
            // incoming in this window. Leaving the cursor put means the next open
            // re-scans the span — safe, because recordEntry dedupes by id.
            let allClean = true;
            for (const token of tokens) {
                const tokenAddr = AztecAddress.fromString(token.address);
                // Per-token best-effort: one token's failed read must not abort
                // the scan of the others.
                try {
                    // PRIVATE incoming only — discoverable when the sender is a
                    // registered sender (contact / known sender). Public transfers
                    // emit no event, so there is nothing to read for them.
                    const evs = await wallet.getPrivateEvents<RawEvent["event"]>(
                        (Token as any).events.Transfer,
                        {
                            contractAddress: tokenAddr,
                            fromBlock: from,
                            toBlock: to,
                            scopes: [AztecAddress.fromString(account)],
                        },
                    );
                    (evs as unknown as RawEvent[]).forEach((ev, i) => {
                        const e = toEntry(ev, token.address, i);
                        if (e) pending.push(e);
                    });
                } catch (err) {
                    allClean = false;
                    console.warn(
                        `tx-history: incoming scan failed for token ${redact(token.address)}`,
                        describeError(err),
                    );
                }
            }

            for (const e of pending) {
                await recordEntry(network.id, account, e);
            }

            // Advance only on a clean pass; otherwise retry this span next open.
            if (allClean) await setScanCursor(network.id, account, latest);
            return pending.length;
        } catch (err) {
            // Best-effort: a top-level failure (node unreachable, etc.) yields
            // zero new rows rather than throwing into the history screen.
            console.warn(`tx-history: scanIncoming failed for ${redact(account)}`, describeError(err));
            return 0;
        }
    });
}
