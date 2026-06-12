import { formatFeeAztec } from "../../lib/aztec/balances";
import type { UiFeeEstimate } from "../../lib/aztec/fee";

/**
 * Pre-confirm network-fee line. Shows an ESTIMATE (never an exact figure — base
 * fees move before inclusion), or "Covered" when a sponsored fee payer foots
 * the bill. A bridged fee-juice claim is presented as a normal fee (it does come
 * out of the user's gas). When this is the account's FIRST transaction it also
 * activates the account on-chain, so a one-time extra amount is deducted — noted
 * only when the user is actually paying (an activation under a sponsor is free).
 */
export function FeeEstimateRow({
    estimate,
    firstTx,
}: {
    /** null = still estimating. */
    estimate: UiFeeEstimate | null;
    firstTx?: boolean;
}) {
    let value: React.ReactNode;
    if (estimate === null) value = <span className="muted">Estimating…</span>;
    else if (estimate.covered) value = <span style={{ color: "var(--success)" }}>Covered</span>;
    else if (estimate.feeJuice === null) value = <span className="muted">Unavailable</span>;
    else value = <>≈ {formatFeeAztec(estimate.feeJuice)} AZTEC</>;

    const showFirstTxNote = !!firstTx && estimate !== null && !estimate.covered;

    return (
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="muted">Network fee</span>
                <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
            </div>
            {showFirstTxNote && (
                <div className="hint" style={{ fontSize: 11 }}>
                    First transaction also activates your account on-chain — a small additional
                    amount is deducted this one time.
                </div>
            )}
        </div>
    );
}

/** Post-send ACTUAL network fee (read from the mined receipt). */
export function ActualFeeRow({ feeJuice }: { feeJuice?: bigint }) {
    if (feeJuice === undefined) return null;
    return (
        <div className="muted" style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
            Network fee: {formatFeeAztec(feeJuice)} AZTEC
        </div>
    );
}
