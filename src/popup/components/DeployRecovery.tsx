import { useCallback, useEffect, useState } from "react";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { useWallet } from "../../lib/state/walletContext";
import { clearDeployJournal, readDeployJournal, type DeployJournal } from "../../lib/state/opJournal";
import { getDeployTask, useDeployTask } from "../../lib/state/deployTask";
import { addToken } from "../../lib/aztec/tokens";
import { describeError } from "../../lib/errors";

/**
 * Shown on Home when a previous session left a deploy journal behind — i.e.
 * the page died mid-deploy (toolbar popup closed on blur). The journaled
 * address is deterministic, so we ask the chain what actually happened:
 *
 *   contract exists  → the deploy LANDED while the page was dead. Import the
 *                      token and celebrate instead of gaslighting the user.
 *   contract absent  → explain the interruption (it may also still be in
 *                      flight — "Check again" re-probes).
 *
 * This is STRICTLY a cross-session recovery banner. While a deploy is live in
 * THIS session, deployTask owns every word the user sees (Deploy page + the
 * Shell's status bar), so this component stands down — see the liveTask guards.
 */
export function DeployRecovery({ onRecovered }: { onRecovered: () => void }) {
    const { wallet, network, account } = useWallet();
    // A live in-session deploy narrates itself. The crash journal is written
    // mid-deploy, so without this guard the banner would fire on the running
    // deploy too — claiming "interrupted" while it's still proving.
    const liveTask = useDeployTask();
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
                    // Older journals lack the deployer — credit the active
                    // account then (the journal is session-scoped; new ones
                    // always record it).
                    const owner = j.deployer ?? account?.address.toString();
                    if (!owner) throw new Error("No account loaded to credit the recovered token to.");
                    await addToken(
                        j.networkId as any,
                        owner,
                        {
                            address: j.predictedAddress,
                            symbol: j.symbol,
                            name: j.name,
                            decimals: j.decimals,
                        },
                        // Recovery is about "is it in the list now?", not "did I
                        // add it" — already present (imported by other means) is
                        // a success, not a "Token already imported" error.
                        { ifExists: "ignore" },
                    );
                    await clearDeployJournal();
                    setRecovered(true);
                    onRecovered();
                }
            } catch (e) {
                setProbeError(describeError(e));
            } finally {
                setChecking(false);
            }
        },
        [wallet, account, onRecovered],
    );

    useEffect(() => {
        if (!wallet) return;
        // Don't even read the journal while a deploy is live this session — the
        // probe could find the contract mid-flight and race the deploy's own
        // addToken (the cause of the bogus "Token already imported" failure).
        if (getDeployTask()) return;
        void readDeployJournal().then((j) => {
            if (j && j.networkId === network.id) {
                setJournal(j);
                void probe(j);
            }
        });
    }, [wallet, network.id, probe]);

    // A live deploy is being narrated by the Deploy page + status bar — this
    // recovery banner only ever speaks for a deploy from a PRIOR, dead session.
    if (liveTask) return null;
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
