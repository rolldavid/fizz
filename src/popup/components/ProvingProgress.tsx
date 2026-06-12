import { useEffect, useState } from "react";

/**
 * Time-based progress for client-side proving. Proof generation is ~45s of
 * silence that reads as a hang; a bar moving toward done reads as work. It
 * eases to 95% over PROVING_ESTIMATE_S and holds there — never claiming done
 * before the receipt actually lands (slow machines / first-run key loading).
 * The stage line lives HERE so buttons stay short ("Sending…").
 */
const PROVING_ESTIMATE_S = 45;

export function ProvingProgress({ status }: { status: string }) {
    const [pct, setPct] = useState(0);
    useEffect(() => {
        const started = Date.now();
        const t = window.setInterval(() => {
            const elapsed = (Date.now() - started) / 1000;
            setPct(Math.min(95, (elapsed / PROVING_ESTIMATE_S) * 100));
        }, 250);
        return () => window.clearInterval(t);
    }, []);
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="muted" style={{ fontSize: 12 }}>{status}</div>
            <div className="progress-track">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}

/** Shared "gas is incoming / absent" cards for gas-gated flows. */
export function GasGateCards({
    gate,
    actionLabel,
    onRecheck,
}: {
    gate: "incoming" | "none" | null;
    /** e.g. "this send", "this conversion", "this mint" */
    actionLabel: string;
    onRecheck?: () => void;
}) {
    if (gate === "incoming") {
        return (
            <div className="card card-accent" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontWeight: 600 }}>Your gas is on the way</div>
                <div className="hint" style={{ margin: 0 }}>
                    A bridge to this account is still landing — the gas usually becomes usable
                    within a few minutes, and {actionLabel} will use it automatically. Check
                    again shortly.
                </div>
                {onRecheck && (
                    <button
                        className="btn btn-ghost"
                        style={{ fontSize: 12, padding: "6px 12px", alignSelf: "flex-start" }}
                        onClick={onRecheck}
                    >
                        Check again
                    </button>
                )}
            </div>
        );
    }
    if (gate === "none") {
        return (
            <div className="card card-accent" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontWeight: 600 }}>You need gas first</div>
                <div className="hint" style={{ margin: 0 }}>
                    This account has no fee juice, and every Aztec transaction needs some. Get
                    gas for THIS account, wait for it to land (it arrives automatically), then
                    come back.
                </div>
                <a
                    className="btn btn-primary btn-block"
                    href="https://fizzwallet.com/bridge"
                    target="_blank"
                    rel="noreferrer"
                >
                    Get gas ↗
                </a>
            </div>
        );
    }
    return null;
}
