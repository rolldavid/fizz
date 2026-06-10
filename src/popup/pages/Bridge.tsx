import { useCallback, useEffect, useState } from "react";
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
    recoverInFlightBridges,
    type PendingBridge,
} from "../../lib/aztec/bridge";
import { drainClaimInbox, importClaimTicketText } from "../../lib/aztec/claimInbox";
import { formatUnits } from "../../lib/aztec/balances";

/**
 * Fee juice screen — the wallet is just a wallet, so ACQUIRING fee juice
 * lives on fizzwallet.com/bridge (connect this wallet there; the deposit's
 * claim lands here automatically). This screen keeps the wallet-side
 * bookkeeping only:
 *   - pending claims (with in-flight/failed states + recovery)
 *   - manual claim-ticket import (fallback when the auto-handoff didn't run)
 *   - sandbox-only: one-click local mint for development
 */
export function Bridge({ onBack }: { onBack: () => void }) {
    const { wallet, account, network } = useWallet();
    const isSandbox = network.id === "sandbox";
    const isAlpha = network.id === "alpha";
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [pending, setPending] = useState<PendingBridge[]>([]);
    const [refreshError, setRefreshError] = useState<string | null>(null);
    const [showImport, setShowImport] = useState(false);
    const [importText, setImportText] = useState("");
    const [importMsg, setImportMsg] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        // Every failure path lands in visible state — an escaped rejection
        // here is an invisible dead screen.
        try {
            setRefreshError(null);
            // Adopt claim tickets handed over by fizzwallet.com/bridge.
            await drainClaimInbox();
            // Complete deposits whose page died mid-broadcast (from L1 receipts).
            if (wallet && network.l1RpcUrl) {
                const { l1ContractAddresses } = await (wallet as any).aztecNode.getNodeInfo();
                const portal = l1ContractAddresses.feeJuicePortalAddress?.toString();
                if (portal) await recoverInFlightBridges(network.id, network.l1RpcUrl, portal);
            }
            setPending(await listPendingBridges(network.id));
        } catch (e) {
            setRefreshError(e instanceof Error ? e.message : String(e));
        }
    }, [network, wallet]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    function sandboxBridge() {
        if (!wallet || !account) return setError("Wallet not loaded.");
        setError(null);
        setDone(false);
        setBusy(true);
        // trackOp: L1 txs + confirmation can outlast the idle window.
        trackOp(async () => {
            await bridgeFeeJuice({
                wallet,
                network,
                recipient: account.address,
                amount: SANDBOX_MINT_AMOUNT,
                provider: directRpcProvider(SANDBOX_L1_RPC_URL),
                mint: true,
            });
        })
            .then(async () => {
                setDone(true);
                await refresh();
            })
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
    }

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
                            One click. The local L1 mints a fixed batch and deposits it to your
                            account. Your next transaction claims it automatically.
                        </p>
                        <button
                            className="btn btn-primary btn-block"
                            disabled={busy}
                            onClick={sandboxBridge}
                        >
                            {busy
                                ? "Minting + depositing on local L1…"
                                : `Get ${formatUnits(SANDBOX_MINT_AMOUNT, 18)} JUICE`}
                        </button>
                    </>
                ) : (
                    <>
                        <p className="hint">
                            {isAlpha
                                ? "Fee juice pays Aztec network fees. On mainnet there's no " +
                                  "sponsor. Every transaction needs fee juice, so you'll want some " +
                                  "before sending or deploying."
                                : "Fee juice pays Aztec network fees (~2.3 per transaction). On " +
                                  "testnet your fees are usually sponsored, so this is optional."}
                        </p>
                        {/* Acquisition lives on the web bridge — the wallet stays a wallet. */}
                        <div
                            className="card card-accent"
                            style={{ display: "flex", flexDirection: "column", gap: 8 }}
                        >
                            <div style={{ fontWeight: 600 }}>Need fee juice?</div>
                            <div className="hint" style={{ margin: 0 }}>
                                {isAlpha
                                    ? "Bridge AZTEC → fee juice on our web bridge. You enter this " +
                                      "wallet's address there; the claim lands back here and " +
                                      "auto-pays your next transaction."
                                    : "Bridge it from Ethereum on our web bridge. The claim lands " +
                                      "back here and auto-pays your next transaction."}
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

                        {/* Manual ticket import — fallback when the page couldn't
                            hand the claim over automatically. */}
                        <div>
                            <button
                                className="muted"
                                style={{ fontSize: 11 }}
                                onClick={() => setShowImport((s) => !s)}
                            >
                                {showImport ? "▾" : "▸"} Bridged on the web and need to import
                                your claim ticket?
                            </button>
                            {showImport && (
                                <div
                                    className="card fade-in"
                                    style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 8 }}
                                >
                                    <textarea
                                        rows={3}
                                        placeholder="fizzclaim1:…"
                                        value={importText}
                                        onChange={(e) => setImportText(e.target.value)}
                                        style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}
                                    />
                                    <button
                                        className="btn btn-ghost btn-block"
                                        disabled={!importText.trim()}
                                        onClick={async () => {
                                            setImportMsg(null);
                                            try {
                                                const n = await importClaimTicketText(importText);
                                                setImportText("");
                                                setImportMsg(
                                                    n > 0
                                                        ? "✓ Claim imported. It auto-pays your next transaction once ready."
                                                        : "Already imported.",
                                                );
                                                await refresh();
                                            } catch (e) {
                                                setImportMsg(
                                                    e instanceof Error ? e.message : String(e),
                                                );
                                            }
                                        }}
                                    >
                                        Import ticket
                                    </button>
                                    {importMsg && (
                                        <div className="hint" style={{ margin: 0 }}>
                                            {importMsg}
                                        </div>
                                    )}
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
                            The claim lands on L2 in a few minutes and your next transaction uses
                            it automatically, nothing else to do.
                        </div>
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
                                            `Posted ${new Date(b.createdAt).toLocaleString()} · auto-claims on your next outgoing transaction.`}
                                        {status === "sent" &&
                                            "L1 deposit sent, confirming. This finishes automatically; check back in a minute."}
                                        {status === "depositing" &&
                                            "Interrupted before the deposit reached L1 (the window closed). Nothing was bridged. Dismiss and retry."}
                                        {status === "failed" &&
                                            "The L1 deposit transaction reverted. Dismiss and retry."}
                                    </div>
                                    {(status === "depositing" || status === "failed") && (
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
