import { useEffect, useState } from "react";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Header } from "../components/Header";
import { ArrowLeftIcon, CheckIcon } from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";
import { trackOp } from "../../lib/state/activity";
import { loadTokens, type TokenEntry } from "../../lib/aztec/tokens";
import {
    formatUnits,
    getTokenBalance,
    parseUnits,
    ZERO_BALANCE,
    type TokenBalance,
} from "../../lib/aztec/balances";
import { shield, unshield } from "../../lib/aztec/transfer";
import { assessFeeReadiness } from "../../lib/aztec/fee";
import { GasGateCards, ProvingProgress } from "../components/ProvingProgress";

/** Which way the conversion goes — set when the user taps Convert on a token row. */
export type ConvertTarget = { tokenAddress: string; direction: "shield" | "unshield" };

/**
 * Convert a token between your own private and public balances (shield /
 * unshield). Reached from a token row's convert icon; the direction is the
 * OPPOSITE of the list it was tapped from (private row → make public).
 */
export function Convert({ target, onBack }: { target: ConvertTarget; onBack: () => void }) {
    const { wallet, network, account, ensureAccountDeployed } = useWallet();
    const makingPrivate = target.direction === "shield"; // public → private

    const [token, setToken] = useState<TokenEntry | null>(null);
    const [balance, setBalance] = useState<TokenBalance>(ZERO_BALANCE);
    const [amount, setAmount] = useState("");
    const [busy, setBusy] = useState(false);
    /** Stage line shown above the proving progress bar (NOT on buttons). */
    const [stage, setStage] = useState("");
    const [checking, setChecking] = useState(false);
    const [gasGate, setGasGate] = useState<"incoming" | "none" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<{ txHash: string } | null>(null);

    useEffect(() => {
        if (!account) return;
        loadTokens(network.id, account.address.toString()).then((list) =>
            setToken(list.find((t) => t.address === target.tokenAddress) ?? null),
        );
    }, [network.id, account, target.tokenAddress]);

    useEffect(() => {
        if (!wallet || !account || !token) return;
        let cancelled = false;
        getTokenBalance(wallet, account.address, token)
            .then((b) => !cancelled && setBalance(b))
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [wallet, account, token, done]);

    const decimals = token?.decimals ?? 18;
    const symbol = token?.symbol ?? "";
    const fmt = (v: bigint) => formatUnits(v, decimals);
    const fromBal = makingPrivate ? balance.public : balance.private;
    const fromLabel = makingPrivate ? "public" : "private";
    const toLabel = makingPrivate ? "private" : "public";

    async function submit() {
        setError(null);
        setGasGate(null);
        if (!wallet || !account || !token) return setError("Wallet not loaded.");
        // Gas gate BEFORE building anything (same as Send/Deploy) — covers
        // both the account's FIRST transaction (which also deploys its account
        // contract and needs a fee source for that) and subsequent ones.
        setChecking(true);
        try {
            const readiness = await assessFeeReadiness(wallet, network, account.address);
            if (readiness.kind !== "ready") {
                setGasGate(readiness.kind);
                return;
            }
        } catch (e) {
            return setError(e instanceof Error ? e.message : String(e));
        } finally {
            setChecking(false);
        }
        setBusy(true);
        try {
            await trackOp(async () => {
                const value = parseUnits(amount, token.decimals);
                if (value <= 0n) throw new Error("Amount must be greater than zero.");
                if (value > fromBal) {
                    throw new Error(
                        `Amount exceeds your ${fromLabel} balance of ${fmt(fromBal)} ${token.symbol}.`,
                    );
                }
                const tokenAddress = AztecAddress.fromString(token.address);
                const sender = account.address;
                if (!account.isDeployed) {
                    setStage("Activating your account — first transaction only (takes a few minutes)…");
                    await ensureAccountDeployed();
                }
                setStage("Generating a private proof on your device (~45 seconds)…");
                const result = makingPrivate
                    ? await shield({ wallet, network, sender, tokenAddress, amount: value })
                    : await unshield({ wallet, network, sender, tokenAddress, amount: value });
                setDone({ txHash: result.txHash });
                setAmount("");
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    if (done) {
        return (
            <>
                <Header />
                <div className="content">
                    <div style={{ textAlign: "center", marginTop: 24 }}>
                        <div
                            style={{
                                width: 56,
                                height: 56,
                                borderRadius: "50%",
                                background: "rgba(74, 222, 128, 0.15)",
                                color: "var(--success)",
                                display: "grid",
                                placeItems: "center",
                                margin: "0 auto 12px",
                            }}
                        >
                            <CheckIcon size={28} />
                        </div>
                        <div style={{ fontWeight: 600, fontSize: 18 }}>
                            Converted to {toLabel}
                        </div>
                        <div className="muted" style={{ marginTop: 4 }}>
                            Your {symbol} balance updates in a moment.
                        </div>
                    </div>
                    <button className="btn btn-primary btn-block" onClick={onBack}>
                        Back to wallet
                    </button>
                </div>
            </>
        );
    }

    return (
        <>
            <Header />
            <div className="content">
                <button
                    className="muted"
                    style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 4 }}
                    onClick={onBack}
                >
                    <ArrowLeftIcon size={14} /> Back
                </button>

                <div style={{ fontWeight: 600, fontSize: 16 }}>
                    Make {symbol} {toLabel}
                </div>
                <p className="hint">
                    {makingPrivate
                        ? "Moves your public balance into your private balance. It stays in your wallet, just hidden on-chain."
                        : "Moves your private balance back to public. It stays in your wallet, now visible on-chain."}
                </p>

                <div className="card" style={{ display: "flex", justifyContent: "space-between" }}>
                    <span className="muted">Your {fromLabel} {symbol}</span>
                    <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmt(fromBal)}</span>
                </div>

                <div className="field">
                    <label>Amount to make {toLabel}</label>
                    <input
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.0"
                        disabled={busy}
                    />
                    <p className="sub-label">
                        <button
                            type="button"
                            className="btn btn-ghost btn-small"
                            disabled={busy || fromBal === 0n}
                            onClick={() => setAmount(fmt(fromBal))}
                        >
                            Use full {fromLabel} balance
                        </button>
                    </p>
                </div>

                <div className="hint" style={{ fontSize: 11 }}>
                    ⚠️ Converting touches the public ledger with your address and the exact amount.
                    Converting the same amount in and out makes the two sides easy to link. Vary
                    amounts and timing if that matters to you.
                </div>

                {error && <div className="error">{error}</div>}

                <GasGateCards gate={gasGate} actionLabel="this conversion" onRecheck={() => void submit()} />

                {busy && <ProvingProgress status={stage} />}

                <button
                    className="btn btn-primary btn-block"
                    disabled={busy || !token || !amount}
                    onClick={submit}
                >
                    {busy ? "Converting…" : checking ? "Checking…" : `Make ${toLabel}`}
                </button>
                {busy && (
                    <div className="hint">
                        Proof generation runs locally in your browser. This can take 10-30s the first
                        time as the proving keys load.
                    </div>
                )}
            </div>
        </>
    );
}
