import { useCallback, useEffect, useState } from "react";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { useWallet } from "../../lib/state/walletContext";
import { clearDeployJournal, readDeployJournal, type DeployJournal } from "../../lib/state/opJournal";
import { addToken } from "../../lib/aztec/tokens";

/**
 * Shown on Home when a previous session left a deploy journal behind — i.e.
 * the page died mid-deploy (toolbar popup closed on blur). The journaled
 * address is deterministic, so we ask the chain what actually happened:
 *
 *   contract exists  → the deploy LANDED while the page was dead. Import the
 *                      token and celebrate instead of gaslighting the user.
 *   contract absent  → explain the interruption (it may also still be in
 *                      flight — "Check again" re-probes).
 */
export function DeployRecovery({ onRecovered }: { onRecovered: () => void }) {
    const { wallet, network } = useWallet();
    const [journal, setJournal] = useState<DeployJournal | null>(null);
    const [recovered, setRecovered] = useState(false);
    const [checking, setChecking] = useState(false);
    const [probeError, setProbeError] = useState<string | null>(null);

    const probe = useCallback(
        async (j: DeployJournal) => {
            if (!wallet) return;
            setChecking(true);
            setProbeError(null);
            try {
                const instance = await (wallet as any).aztecNode.getContract(
                    AztecAddress.fromString(j.predictedAddress),
                );
                if (instance) {
                    await addToken(j.networkId as any, {
                        address: j.predictedAddress,
                        symbol: j.symbol,
                        name: j.name,
                        decimals: j.decimals,
                    });
                    await clearDeployJournal();
                    setRecovered(true);
                    onRecovered();
                }
            } catch (e) {
                setProbeError(e instanceof Error ? e.message : String(e));
            } finally {
                setChecking(false);
            }
        },
        [wallet, onRecovered],
    );

    useEffect(() => {
        if (!wallet) return;
        void readDeployJournal().then((j) => {
            if (j && j.networkId === network.id) {
                setJournal(j);
                void probe(j);
            }
        });
    }, [wallet, network.id, probe]);

    if (!journal) return null;

    if (recovered) {
        return (
            <div className="card fade-in" style={{ borderColor: "var(--success)" }}>
                <div style={{ color: "var(--success)", fontWeight: 500 }}>
                    ✓ {journal.symbol} deploy finished on-chain
                </div>
                <div className="hint" style={{ marginTop: 4 }}>
                    It completed while the window was closed. We've added it to your list.
                    {journal.hadInitialSupply &&
                        " The initial-supply mint didn't run (it's a second step). Mint it from the token menu."}
                </div>
            </div>
        );
    }

    return (
        <div className="card fade-in" style={{ borderColor: "var(--accent)" }}>
            <div style={{ fontWeight: 500 }}>Your {journal.symbol} deploy was interrupted</div>
            <div className="hint" style={{ marginTop: 4 }}>
                The window closed mid-deploy, which cancels the work (it may also still be
                landing, check again in a minute). Next time use “Open in a window” and keep
                it open until the confirmation shows.
            </div>
            {probeError && <div className="error" style={{ marginTop: 6 }}>{probeError}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                    className="btn btn-ghost"
                    style={{ fontSize: 11, padding: "4px 10px" }}
                    disabled={checking}
                    onClick={() => probe(journal)}
                >
                    {checking ? "Checking…" : "Check again"}
                </button>
                <button
                    className="btn btn-ghost"
                    style={{ fontSize: 11, padding: "4px 10px" }}
                    onClick={async () => {
                        await clearDeployJournal();
                        setJournal(null);
                    }}
                >
                    Dismiss
                </button>
            </div>
        </div>
    );
}
