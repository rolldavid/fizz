import { useCallback, useEffect, useMemo, useState } from "react";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Header } from "../components/Header";
import { ArrowLeftIcon } from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";
import { trackOp } from "../../lib/state/activity";
import { loadTokens, type TokenEntry } from "../../lib/aztec/tokens";
import { parseUnits } from "../../lib/aztec/balances";
import { estimateMintFee, getMintAuthority, mintToken, type MintAuthority } from "../../lib/aztec/mint";
import { assessFeeReadiness, type UiFeeEstimate } from "../../lib/aztec/fee";
import { GasGateCards, ProvingProgress } from "../components/ProvingProgress";
import { ActualFeeRow, FeeEstimateRow } from "../components/FeeEstimate";
import { describeError, humanizeTxError } from "../../lib/errors";

/**
 * Mint screen — create new supply on a token where this account holds the
 * minter role. Authority is checked on token selection; the form only unlocks
 * for tokens the account can actually mint on.
 */
export function Mint({ onBack }: { onBack: () => void }) {
    const { wallet, network, account, ensureAccountDeployed } = useWallet();
    const [tokens, setTokens] = useState<TokenEntry[]>([]);
    const [tokenAddr, setTokenAddr] = useState("");
    const [authority, setAuthority] = useState<MintAuthority | null>(null);
    const [authError, setAuthError] = useState<string | null>(null);
    const [checkingAuth, setCheckingAuth] = useState(false);

    const [amount, setAmount] = useState("");
    const [mode, setMode] = useState<"private" | "public">("private");
    const [toSelf, setToSelf] = useState(true);
    const [to, setTo] = useState("");

    const [busy, setBusy] = useState(false);
    /** Stage line shown above the proving progress bar (NOT on buttons). */
    const [stage, setStage] = useState("");
    const [checking, setChecking] = useState(false);
    const [gasGate, setGasGate] = useState<"incoming" | "none" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [feeEst, setFeeEst] = useState<UiFeeEstimate | null>(null);
    const [done, setDone] = useState<{ txHash: string; feeJuice?: bigint } | null>(null);

    useEffect(() => {
        if (!account) return;
        loadTokens(network.id, account.address.toString()).then((list) => {
            const real = list.filter((t) => t.kind !== "fee_juice");
            setTokens(real);
            if (real[0]) setTokenAddr(real[0].address);
        });
    }, [network.id, account]);

    const token = useMemo(() => tokens.find((t) => t.address === tokenAddr), [tokens, tokenAddr]);

    const checkAuthority = useCallback(async () => {
        setAuthority(null);
        setAuthError(null);
        if (!wallet || !account || !token) return;
        setCheckingAuth(true);
        try {
            const auth = await getMintAuthority(
                wallet,
                AztecAddress.fromString(token.address),
                account.address,
            );
            setAuthority(auth);
        } catch (e) {
            setAuthError(describeError(e));
        } finally {
            setCheckingAuth(false);
        }
    }, [wallet, account, token]);

    useEffect(() => {
        checkAuthority();
    }, [checkAuthority]);

    async function submit() {
        setError(null);
        setDone(null);
        setGasGate(null);
        if (!wallet) return setError("Wallet not loaded.");
        if (!account) return setError("Account not loaded.");
        if (!token) return setError("Pick a token.");
        // Gas gate BEFORE building anything (same as Send/Deploy/Convert) —
        // covers the account's FIRST transaction (which also deploys its
        // account contract) and subsequent ones alike.
        setChecking(true);
        try {
            const readiness = await assessFeeReadiness(wallet, network, account.address);
            if (readiness.kind !== "ready") {
                setGasGate(readiness.kind);
                return;
            }
        } catch (e) {
            return setError(describeError(e));
        } finally {
            setChecking(false);
        }
        setBusy(true);
        try {
            // trackOp: proving + inclusion can exceed the idle window; the
            // auto-lock defers while this runs instead of killing the tx.
            await trackOp(async () => {
                const value = parseUnits(amount, token.decimals);
                const recipient = toSelf ? account.address : AztecAddress.fromString(to.trim());
                if (!account.isDeployed) {
                    setStage("Activating your account — first transaction only (takes a few minutes)…");
                    await ensureAccountDeployed();
                }
                setStage("Generating a private proof on your device (~45 seconds)…");
                const result = await mintToken({
                    wallet,
                    network,
                    minter: account.address,
                    tokenAddress: AztecAddress.fromString(token.address),
                    to: recipient,
                    amount: value,
                    mode,
                });
                setDone({ txHash: result.txHash, feeJuice: result.feeJuice });
                setAmount("");
            });
        } catch (e) {
            setError(humanizeTxError(e));
        } finally {
            setBusy(false);
        }
    }

    const canMint = authority?.isMinter === true;
    // True exactly when the estimate effect will actually run, so the fee row
    // isn't shown stuck on "Estimating…" for "0"/junk or an invalid recipient.
    const feeEstInput = (() => {
        if (!canMint || !token || !amount) return false;
        try {
            if (parseUnits(amount, token.decimals) <= 0n) return false;
            if (!toSelf) AztecAddress.fromString(to.trim());
            return true;
        } catch {
            return false;
        }
    })();

    // Debounced fee estimate as the user fills the mint form.
    useEffect(() => {
        if (!wallet || !account || !token || !amount || !canMint) {
            setFeeEst(null);
            return;
        }
        let value: bigint;
        let recipient: AztecAddress;
        try {
            value = parseUnits(amount, token.decimals);
            if (value <= 0n) {
                setFeeEst(null);
                return;
            }
            recipient = toSelf ? account.address : AztecAddress.fromString(to.trim());
        } catch {
            setFeeEst(null);
            return;
        }
        let cancelled = false;
        setFeeEst(null);
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const est = await estimateMintFee({
                        wallet,
                        network,
                        minter: account.address,
                        tokenAddress: AztecAddress.fromString(token.address),
                        to: recipient,
                        amount: value,
                        mode,
                    });
                    if (!cancelled) setFeeEst(est);
                } catch {
                    if (!cancelled) setFeeEst({ covered: false, feeJuice: null });
                }
            })();
        }, 400);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [wallet, account, token, amount, mode, toSelf, to, canMint, network]);

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

                <div style={{ fontWeight: 600, fontSize: 16 }}>Mint tokens</div>
                <p className="hint">
                    Creates new supply on a token where you hold the minter role, directly into a
                    private or public balance.
                </p>

                <div className="field">
                    <label>Token</label>
                    <select value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value)}>
                        {tokens.length === 0 && <option value="">No tokens imported</option>}
                        {tokens.map((t) => (
                            <option key={t.address} value={t.address}>
                                {t.symbol}: {t.name}
                            </option>
                        ))}
                    </select>
                </div>

                {checkingAuth && <div className="hint">Checking mint authority…</div>}
                {authError && <div className="error">{authError}</div>}
                {token && authority && !authority.isMinter && (
                    <div className="card hint">
                        This account doesn't hold the minter role for {token.symbol}
                        {authority.isAdmin
                            ? ", but you're the admin, so you can grant it to yourself from the token's management tools."
                            : "."}
                    </div>
                )}

                {canMint && (
                    <>
                        <div className="field">
                            <label>Amount</label>
                            <input
                                inputMode="decimal"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                placeholder="0.0"
                            />
                        </div>

                        <div className="field">
                            <label>Mint into</label>
                            <div className="tabs">
                                <button
                                    className={`tab private ${mode === "private" ? "active" : ""}`}
                                    onClick={() => setMode("private")}
                                >
                                    <span className="tab-dot" /> Private balance
                                </button>
                                <button
                                    className={`tab ${mode === "public" ? "active" : ""}`}
                                    onClick={() => setMode("public")}
                                >
                                    Public balance
                                </button>
                            </div>
                        </div>

                        <div className="field">
                            <label>Recipient</label>
                            <div className="tabs">
                                <button
                                    className={`tab ${toSelf ? "active" : ""}`}
                                    onClick={() => setToSelf(true)}
                                >
                                    Myself
                                </button>
                                <button
                                    className={`tab ${!toSelf ? "active" : ""}`}
                                    onClick={() => setToSelf(false)}
                                >
                                    Another address
                                </button>
                            </div>
                        </div>

                        {!toSelf && (
                            <div className="field">
                                <label>Recipient address</label>
                                <input
                                    value={to}
                                    onChange={(e) => setTo(e.target.value)}
                                    placeholder="0x…"
                                    style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
                                />
                            </div>
                        )}

                        <div className="hint">
                            {mode === "private"
                                ? "Minted privately. The new supply appears only in the recipient's private balance."
                                : "Minted publicly. The new supply is visible on-chain in the recipient's public balance."}
                        </div>

                        {error && <div className="error">{error}</div>}

                        <GasGateCards gate={gasGate} actionLabel="this mint" onRecheck={() => void submit()} />

                        {!busy && !done && feeEstInput && (
                            <FeeEstimateRow estimate={feeEst} firstTx={!account?.isDeployed} />
                        )}

                        {busy && <ProvingProgress status={stage} />}

                        {done && (
                            <div className="card" style={{ borderColor: "var(--success)" }}>
                                <div style={{ color: "var(--success)", marginBottom: 4, fontWeight: 500 }}>
                                    Minted
                                </div>
                                <div
                                    style={{
                                        fontFamily: "ui-monospace, monospace",
                                        fontSize: 11,
                                        wordBreak: "break-all",
                                        color: "var(--text-dim)",
                                    }}
                                >
                                    {done.txHash}
                                </div>
                                <div style={{ marginTop: 6 }}>
                                    <ActualFeeRow feeJuice={done.feeJuice} />
                                </div>
                            </div>
                        )}

                        <button
                            className="btn btn-primary btn-block"
                            disabled={busy || !token || !amount || (!toSelf && !to)}
                            onClick={submit}
                        >
                            {busy ? "Minting…" : checking ? "Checking…" : "Mint"}
                        </button>
                        {busy && (
                            <div className="hint">
                                Proof generation runs locally in your browser. This can take a little
                                while.
                            </div>
                        )}
                    </>
                )}
            </div>
        </>
    );
}
