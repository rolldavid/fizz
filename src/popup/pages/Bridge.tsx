import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "../components/Header";
import { useWallet } from "../../lib/state/walletContext";
import { trackOp } from "../../lib/state/activity";
import {
    SANDBOX_L1_RPC_URL,
    SANDBOX_MINT_AMOUNT,
    bridgeFeeJuice,
    directRpcProvider,
    dismissBridge,
    listPendingBridges,
    prepareBridgeClaim,
    recordBridgeDeposit,
    recoverInFlightBridges,
    type PendingBridge,
} from "../../lib/aztec/bridge";
import { drainClaimInbox } from "../../lib/aztec/claimInbox";
import { onFeeJuiceLanded } from "../../lib/aztec/autoClaim";
import {
    clearBridgeDeposit,
    clearBridgeParams,
    clearPrepare,
    readBridgeDeposit,
    readPrepare,
    saveBridgeParams,
} from "../../lib/state/bridgeHandoff";
import { formatUnits } from "../../lib/aztec/balances";
import { vaultStore } from "../../lib/vault/store";
import { deriveBridgeClaimSecret } from "../../lib/aztec/wallet";
import { bumpClaimIndex, nextClaimIndex, recoverBridgedClaims } from "../../lib/aztec/claimRecovery";
import { describeError } from "../../lib/errors";

type PrepPhase = "confirm" | "awaiting" | "completing" | "done";

/**
 * Display host for the origin that initiated a bridge-prepare. We render the
 * REAL initiating origin on this money-consent screen, not a hardcoded brand:
 * any previously-connected origin can trigger fizz:bridge-prepare, and a
 * consent surface that always says "fizzwallet.com" would misattribute the
 * request to the trusted brand. (React escapes the text, so this is purely
 * about showing the truthful host; falls back to the raw string if unparseable.)
 */
function prepOriginHost(origin: string): string {
    try {
        return new URL(origin).host;
    } catch {
        return origin;
    }
}

/**
 * Fee juice (gas) screen. ACQUIRING fee juice happens on fizzwallet.com/bridge:
 * the user does the L1 deposit there from their own Ethereum wallet, and that
 * page opens THIS window (fizz:bridge-prepare) so the wallet can generate the
 * claim secret for the connected account and complete the claim — no ticket to
 * copy. The secret never leaves the wallet. This screen also lists pending
 * claims and (sandbox only) offers a one-click local mint.
 */
export function Bridge({ onBack }: { onBack: () => void }) {
    const { wallet, account, network } = useWallet();
    const isSandbox = network.id === "sandbox";
    const isAlpha = network.id === "alpha";
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [rescanMsg, setRescanMsg] = useState<string | null>(null);
    const [rescanning, setRescanning] = useState(false);

    // Manual escape hatch for the once-per-install recovery scan: a flaky L1
    // RPC (or an empty answer from a withholding one) must never be a dead
    // end — the user can always re-scan for seed-derived deposits.
    async function rescan() {
        setRescanMsg(null);
        setError(null);
        if (!wallet || !account) return setError("Wallet not loaded.");
        const seed = vaultStore.getUnlocked()?.seed;
        if (!seed) return setError("Wallet is locked.");
        setRescanning(true);
        try {
            const res = await recoverBridgedClaims({
                wallet,
                network,
                seed,
                accountIndex: account.index,
                recipient: account.address,
            });
            setRescanMsg(
                res.scanned === 0
                    ? "No deposits found on L1 for this account."
                    : `Checked ${res.scanned} deposit${res.scanned === 1 ? "" : "s"}; recovered ${res.recovered}.`,
            );
            await refresh();
        } catch (e) {
            setError(describeError(e));
        } finally {
            setRescanning(false);
        }
    }
    const [pending, setPending] = useState<PendingBridge[]>([]);
    const [refreshError, setRefreshError] = useState<string | null>(null);

    // Auto-send prepare flow (this window was opened by the web bridge).
    const [prep, setPrep] = useState<{ amount: string; origin: string } | null>(null);
    const [prepPhase, setPrepPhase] = useState<PrepPhase>("confirm");
    const [prepBusy, setPrepBusy] = useState(false);
    const [prepError, setPrepError] = useState<string | null>(null);
    const pollRef = useRef<number | null>(null);
    const prepBusyRef = useRef(false); // synchronous latch (state lags within a tick)

    const refresh = useCallback(async () => {
        setRefreshError(null);
        try {
            // Migrate any legacy plaintext claim inbox (no-op for current builds).
            await drainClaimInbox();
            // Complete deposits whose flow was interrupted (from L1 receipts).
            if (wallet && network.l1RpcUrl) {
                const { l1ContractAddresses } = await (wallet as any).aztecNode.getNodeInfo();
                const portal = l1ContractAddresses.feeJuicePortalAddress?.toString();
                if (portal) await recoverInFlightBridges(network.id, network.l1RpcUrl, portal);
            }
        } catch (e) {
            setRefreshError(describeError(e));
        }
        // List even when recovery failed: the in-flight cards must stay visible
        // next to the error, not vanish behind it.
        try {
            setPending(await listPendingBridges(network.id));
        } catch (e) {
            setRefreshError(describeError(e));
        }
    }, [network, wallet]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // Drop the card the moment the background claimer lands the juice.
    useEffect(() => onFeeJuiceLanded(() => void refresh()), [refresh]);

    // On open: pick up a prepare hand-off, or — if none — recover a deposit
    // that was reported while this popup was closed, so a confirmed L1 deposit
    // is never stranded (e.g. the page reported it after the window closed).
    useEffect(() => {
        void (async () => {
            const p = await readPrepare();
            if (p) {
                setPrep({ amount: p.amount, origin: p.origin });
                return;
            }
            const dep = await readBridgeDeposit();
            if (!dep) return;
            try {
                // Only clear the (global, cross-network) handoff slot when this
                // deposit actually matched a "depositing" record on the ACTIVE
                // network. recordBridgeDeposit returns null (no throw) when the
                // deposit belongs to a claim prepared on ANOTHER network; clearing
                // unconditionally would destroy the only {secretHash,l1TxHash}
                // copy and strand that cross-network deposit (unrecoverable for
                // random/legacy secrets). Mirrors autoClaim.ts's guarded clear.
                const sent = await recordBridgeDeposit({
                    networkId: network.id,
                    secretHash: dep.secretHash,
                    l1TxHash: dep.l1TxHash,
                });
                if (sent) await clearBridgeDeposit();
                await refresh(); // recoverInFlightBridges completes the "sent" record
            } catch (e) {
                setRefreshError(describeError(e));
            }
        })();
        // Mount-only recovery; refresh/network are stable for this purpose.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function stopPoll() {
        if (pollRef.current !== null) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }
    useEffect(() => stopPoll, []);

    function sandboxBridge() {
        if (!wallet || !account) return setError("Wallet not loaded.");
        setError(null);
        setDone(false);
        setBusy(true);
        trackOp(async () => {
            const seed = vaultStore.getUnlocked()?.seed;
            if (!seed) throw new Error("Wallet is locked.");
            const addr = account.address.toString();
            // Allocate-then-use: bump BEFORE the secret can reach a deposit. A
            // crash after the bump wastes an index (a gap, covered by the
            // recovery scan's window); reuse would make a deposit unclaimable.
            const claimIndex = await nextClaimIndex(network.id, addr);
            await bumpClaimIndex(network.id, addr, claimIndex);
            await bridgeFeeJuice({
                wallet,
                network,
                recipient: account.address,
                amount: SANDBOX_MINT_AMOUNT,
                provider: directRpcProvider(SANDBOX_L1_RPC_URL),
                mint: true,
                claimSecret: await deriveBridgeClaimSecret(seed, account.index, claimIndex),
            });
        })
            .then(async () => {
                setDone(true);
                await refresh();
            })
            .catch((e) => setError(describeError(e)))
            .finally(() => setBusy(false));
    }

    // ── auto-send prepare flow ───────────────────────────────────────────────
    async function approvePrepare() {
        if (prepBusyRef.current) return; // guard against same-tick double-approve
        if (!account || !prep) return setPrepError("Wallet not loaded.");
        prepBusyRef.current = true;
        setPrepBusy(true);
        setPrepError(null);
        try {
            await clearPrepare(); // consume the request
            // Seed-derived secret: re-derivable from the recovery phrase, so a
            // reinstall (even a new browser) can recover this claim from L1.
            const seed = vaultStore.getUnlocked()?.seed;
            if (!seed) throw new Error("Wallet is locked.");
            const addr = account.address.toString();
            // Allocate-then-use: a crash after the bump leaves a harmless gap;
            // reusing an index would make the second deposit unclaimable.
            const claimIndex = await nextClaimIndex(network.id, addr);
            await bumpClaimIndex(network.id, addr, claimIndex);
            const { secretHash } = await prepareBridgeClaim({
                network,
                recipient: account.address,
                amount: BigInt(prep.amount),
                claimSecret: await deriveBridgeClaimSecret(seed, account.index, claimIndex),
            });
            // Hand the page the two PUBLIC values it needs to deposit.
            await saveBridgeParams(account.address.toString(), secretHash);
            setPrepPhase("awaiting");
            startDepositPoll(secretHash);
        } catch (e) {
            setPrepError(describeError(e));
        } finally {
            prepBusyRef.current = false;
            setPrepBusy(false);
        }
    }

    function startDepositPoll(secretHash: string) {
        stopPoll();
        const startedAt = Date.now();
        pollRef.current = window.setInterval(() => {
            void (async () => {
                // Bound the wait to the relay TTL; the deposit can still be
                // recovered later by reopening Fizz.
                if (Date.now() - startedAt > 10 * 60_000) {
                    stopPoll();
                    setPrepError(
                        "Timed out waiting for the deposit. If you completed it on the bridge tab, reopen Fizz to finish.",
                    );
                    return;
                }
                const d = await readBridgeDeposit();
                if (!d || d.secretHash.toLowerCase() !== secretHash.toLowerCase()) return;
                stopPoll();
                setPrepPhase("completing");
                try {
                    // Persist BEFORE clearing the relay: if this throws (e.g. the
                    // vault auto-locked mid-deposit), the deposit slot must
                    // survive so the claim is recovered on the next open. Mark
                    // "sent", then the audited recovery path fetches the L1
                    // receipt and verifies the event (recipient + amount +
                    // secretHash) before completing — a bogus tx never verifies.
                    const sent = await recordBridgeDeposit({ networkId: network.id, secretHash, l1TxHash: d.l1TxHash });
                    if (!sent) throw new Error("No matching prepared claim for this deposit; it was not recorded.");
                    if (wallet && network.l1RpcUrl) {
                        const { l1ContractAddresses } = await (wallet as any).aztecNode.getNodeInfo();
                        const portal = l1ContractAddresses.feeJuicePortalAddress?.toString();
                        if (portal) await recoverInFlightBridges(network.id, network.l1RpcUrl, portal);
                    }
                    await clearBridgeDeposit();
                    await clearBridgeParams();
                    setPrepPhase("done");
                    await refresh();
                } catch (e) {
                    // Keep the deposit slot so the next open recovers it; surface
                    // and return to awaiting (no tight retry loop).
                    setPrepError(
                        (describeError(e)) +
                            ". Reopen Fizz to finish if you completed the deposit.",
                    );
                    setPrepPhase("awaiting");
                }
            })();
        }, 3000);
    }

    async function cancelPrepare() {
        stopPoll();
        await clearPrepare();
        await clearBridgeParams();
        await clearBridgeDeposit();
        setPrep(null);
        // This window was opened just for the hand-off; close it if standalone.
        window.close();
        onBack();
    }

    // ── prepare-flow render ──────────────────────────────────────────────────
    if (prep) {
        return (
            <>
                <Header />
                <div className="content">
                    <div style={{ fontWeight: 600, fontSize: 16 }}>Fund your wallet with fee juice</div>

                    {prepPhase === "confirm" && (
                        <>
                            <p className="hint">
                                <strong>{prepOriginHost(prep.origin)}</strong> wants to send{" "}
                                <strong>{formatUnits(BigInt(prep.amount), 18)} AZTEC</strong> of fee juice to this
                                account. You'll approve the actual deposit in your Ethereum wallet on the bridge
                                tab.
                            </p>
                            <p className="hint">
                                To do this, the bridge page is given <strong>this account's Aztec address</strong>{" "}
                                (a deposit has to name where it lands; it's public on Ethereum either way). Your
                                keys and the claim secret never leave the wallet.
                            </p>
                            {prepError && <div className="error">{prepError}</div>}
                            <button
                                className="btn btn-primary btn-block"
                                disabled={prepBusy}
                                onClick={approvePrepare}
                            >
                                {prepBusy ? "Preparing…" : "Approve"}
                            </button>
                            <button
                                className="btn btn-ghost btn-block"
                                disabled={prepBusy}
                                onClick={cancelPrepare}
                            >
                                Cancel
                            </button>
                        </>
                    )}

                    {prepPhase === "awaiting" && (
                        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span className="spinner" />
                                <span style={{ fontWeight: 500 }}>Waiting for your deposit…</span>
                            </div>
                            <div className="hint" style={{ margin: 0 }}>
                                Go back to the bridge tab and approve the deposit in your Ethereum wallet. This
                                window finishes automatically once it lands. Keep it open.
                            </div>
                            {prepError && <div className="error">{prepError}</div>}
                            <button
                                className="btn btn-ghost"
                                style={{ fontSize: 11, padding: "6px 12px" }}
                                onClick={cancelPrepare}
                            >
                                Cancel
                            </button>
                        </div>
                    )}

                    {prepPhase === "completing" && (
                        <div className="card" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span className="spinner" />
                            <span style={{ fontWeight: 500 }}>Recording your claim…</span>
                        </div>
                    )}

                    {prepPhase === "done" && (
                        <>
                            <div className="card" style={{ borderColor: "var(--success)" }}>
                                <div style={{ color: "var(--success)", fontWeight: 500 }}>
                                    ✓ Fee juice incoming
                                </div>
                                <div className="hint" style={{ marginTop: 4 }}>
                                    The gas becomes usable in a few minutes and is added
                                    automatically with your first transaction — nothing else to do.
                                </div>
                            </div>
                            <button
                                className="btn btn-primary btn-block"
                                onClick={() => {
                                    window.close();
                                    onBack();
                                }}
                            >
                                Done
                            </button>
                        </>
                    )}
                </div>
            </>
        );
    }

    // ── normal render (no prepare hand-off) ──────────────────────────────────
    return (
        <>
            <Header />
            <div className="content">
                <button className="muted" style={{ alignSelf: "flex-start" }} onClick={onBack}>
                    ← Back
                </button>
                <div style={{ fontWeight: 600, fontSize: 16 }}>Fee juice (gas)</div>

                {isSandbox ? (
                    <>
                        <p className="hint">
                            One click. The local L1 mints a fixed batch and deposits it to your account. Your
                            next transaction claims it automatically.
                        </p>
                        <button className="btn btn-primary btn-block" disabled={busy} onClick={sandboxBridge}>
                            {busy
                                ? "Minting + depositing on local L1…"
                                : `Get ${formatUnits(SANDBOX_MINT_AMOUNT, 18)} JUICE`}
                        </button>
                    </>
                ) : (
                    <>
                        <p className="hint">
                            {isAlpha
                                ? "Fee juice pays Aztec network fees. On mainnet every transaction needs it, " +
                                  "so top up before sending or deploying."
                                : "Fee juice pays Aztec network fees (~2.3 per transaction). On testnet your " +
                                  "fees are usually sponsored, so this is optional."}
                        </p>
                        <div
                            className="card card-accent"
                            style={{ display: "flex", flexDirection: "column", gap: 8 }}
                        >
                            <div style={{ fontWeight: 600 }}>Need fee juice?</div>
                            <div className="hint" style={{ margin: 0 }}>
                                Bridge AZTEC into fee juice on our web bridge. Connect this wallet there, enter
                                an amount, and approve the deposit. The fee juice is sent straight to your
                                connected account and pays your first transaction. No claim ticket to copy.
                            </div>
                            <a
                                className="btn btn-primary btn-block"
                                href="https://fizzwallet.com/bridge"
                                target="_blank"
                                rel="noreferrer"
                            >
                                Open fizzwallet.com/bridge ↗
                            </a>
                            {isAlpha && (
                                <div className="hint" style={{ margin: 0, fontSize: 11 }}>
                                    Don't have AZTEC yet? Get it at{" "}
                                    <a href="https://aztec.network/token" target="_blank" rel="noreferrer">
                                        aztec.network/token
                                    </a>
                                    .
                                </div>
                            )}
                        </div>
                    </>
                )}

                {error && <div className="error">{error}</div>}
                {refreshError && <div className="error">{refreshError}</div>}
                {done && (
                    <div className="card" style={{ borderColor: "var(--success)" }}>
                        <div style={{ color: "var(--success)", fontWeight: 500 }}>✓ Deposit sent</div>
                        <div className="hint" style={{ marginTop: 4 }}>
                            The gas becomes usable in a few minutes and is added automatically
                            with your first transaction — nothing else to do.
                        </div>
                    </div>
                )}

                {!isSandbox && network.l1RpcUrl && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <button
                            className="btn btn-ghost"
                            style={{ fontSize: 11, padding: "6px 12px", alignSelf: "flex-start" }}
                            disabled={rescanning}
                            onClick={() => void rescan()}
                        >
                            {rescanning ? "Scanning L1…" : "Recover bridged gas from L1"}
                        </button>
                        {rescanMsg && (
                            <div className="muted" style={{ fontSize: 11 }}>
                                {rescanMsg}
                            </div>
                        )}
                    </div>
                )}

                {pending.length > 0 && (
                    <div>
                        <div className="muted" style={{ marginBottom: 8 }}>
                            Pending claims
                        </div>
                        {pending.map((b) => {
                            const status = b.status ?? "pending";
                            return (
                                <div key={b.id} className="card" style={{ marginBottom: 8 }}>
                                    <div style={{ fontWeight: 500 }}>
                                        {formatUnits(BigInt(b.claimAmount), 18)} JUICE
                                    </div>
                                    <div className="muted" style={{ fontSize: 11 }}>
                                        {status === "pending" &&
                                            `Confirmed — usable in a few minutes. It's added ` +
                                                `automatically with your first transaction.`}
                                        {status === "sent" &&
                                            "L1 deposit sent, confirming. This finishes automatically; check back in a minute."}
                                        {status === "depositing" &&
                                            "Started but not confirmed back to the wallet. If you approved a deposit on the bridge, reopen it to finish; otherwise dismiss."}
                                        {status === "failed" &&
                                            "The L1 deposit didn't complete. Dismiss and retry."}
                                    </div>
                                    {/* Healthy "pending" claims auto-spend; the stuck states get an escape. */}
                                    {status !== "pending" && (
                                        <button
                                            className="btn btn-ghost"
                                            style={{ marginTop: 6, fontSize: 11, padding: "4px 10px" }}
                                            onClick={async () => {
                                                await dismissBridge(b.id);
                                                await refresh();
                                            }}
                                        >
                                            Dismiss
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </>
    );
}
