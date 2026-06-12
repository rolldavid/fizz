import { useEffect, useState } from "react";
import { Header } from "../components/Header";
import { ArrowLeftIcon, CheckIcon, CopyIcon } from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";
import {
    clearDeployTask,
    startTokenDeploy,
    useDeployTask,
} from "../../lib/state/deployTask";
import { parseUnits } from "../../lib/aztec/balances";
import { assessFeeReadiness, type UiFeeEstimate } from "../../lib/aztec/fee";
import { estimateDeployTokenFee } from "../../lib/aztec/deploy";
import { ActualFeeRow, FeeEstimateRow } from "../components/FeeEstimate";

/**
 * Token deployment, fully in-wallet. The deploy itself runs as a background
 * task (deployTask.ts) — this page starts it and renders whatever state the
 * task is in, so the user can leave for Send/Home/etc. mid-deploy and come
 * back via the Shell's bottom status bar without losing anything.
 */
export function Deploy({ onBack }: { onBack: () => void }) {
    const { wallet, network, account, ensureAccountDeployed } = useWallet();
    const task = useDeployTask();

    const [name, setName] = useState("");
    const [symbol, setSymbol] = useState("");
    const [decimals, setDecimals] = useState("18");
    const [supply, setSupply] = useState("");
    const [supplyMode, setSupplyMode] = useState<"private" | "public">("private");
    const [keepMinter, setKeepMinter] = useState(true);

    const [error, setError] = useState<string | null>(null);
    const [checking, setChecking] = useState(false);
    /** Why deploying is blocked: gas is incoming (wait) or absent (go get it). */
    const [gasGate, setGasGate] = useState<"incoming" | "none" | null>(null);
    const [copied, setCopied] = useState(false);
    const [feeEst, setFeeEst] = useState<UiFeeEstimate | null>(null);

    // Visible elapsed clock while proving — minutes of silent "Deploying…"
    // read as a hang; a ticking timer reads as work.
    const startedAt = task?.phase === "running" ? task.startedAt : null;
    const [elapsed, setElapsed] = useState(0);
    useEffect(() => {
        if (startedAt == null) return;
        setElapsed(Math.floor((Date.now() - startedAt) / 1000));
        const t = window.setInterval(
            () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
            1_000,
        );
        return () => window.clearInterval(t);
    }, [startedAt]);

    // Debounced fee estimate for the deploy tx as the form is filled. Only the
    // deploy tx is priced (any initial-supply mint / revoke follow-ups are
    // separate). Best-effort — invalid inputs simply yield no estimate.
    useEffect(() => {
        if (!wallet || !account || !name.trim() || !symbol.trim() || task) {
            setFeeEst(null);
            return;
        }
        let cancelled = false;
        setFeeEst(null);
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const est = await estimateDeployTokenFee({
                        wallet,
                        network,
                        deployer: account.address,
                        name: name.trim(),
                        symbol: symbol.trim().toUpperCase(),
                        decimals: Number(decimals),
                        initialSupply: 0n,
                        initialSupplyMode: supplyMode,
                        keepMinterRole: keepMinter,
                    });
                    if (!cancelled) setFeeEst(est);
                } catch {
                    if (!cancelled) setFeeEst({ covered: false, feeJuice: null });
                }
            })();
        }, 500);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [wallet, account, name, symbol, decimals, supplyMode, keepMinter, network, task]);

    async function deploy() {
        setError(null);
        setGasGate(null);
        // Validate on click instead of disabling the button: a disabled button
        // swallows the click with zero feedback ("nothing happened").
        if (!name.trim() || !symbol.trim()) {
            return setError("Give your token a name and a symbol first.");
        }
        if (!wallet || !account) return setError("Wallet not loaded.");
        // Gas gate BEFORE proving anything (same as Send): the headline gas
        // number includes incoming claims that may not be consumable yet, and
        // a deploy with no usable fee source dies deep in the SDK with an
        // unhelpful error.
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
        try {
            const d = Number(decimals);
            const supplyValue = supply.trim() ? parseUnits(supply, d) : 0n;
            startTokenDeploy({
                wallet,
                network,
                deployer: account.address,
                ensureAccountDeployed,
                accountIsDeployed: account.isDeployed,
                name: name.trim(),
                symbol: symbol.trim().toUpperCase(),
                decimals: d,
                initialSupply: supplyValue,
                initialSupplyMode: supplyMode,
                keepMinterRole: keepMinter,
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }

    async function copy(text: string) {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    // ── live progress (deploy running, possibly started before this visit) ──
    if (task?.phase === "running") {
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
                        Deploying {task.symbol}…
                    </div>

                    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                fontVariantNumeric: "tabular-nums",
                            }}
                        >
                            <span className="spinner" />
                            <span style={{ fontWeight: 500 }}>
                                {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}{" "}
                                elapsed
                            </span>
                            <span className="muted">· usually 2–4 min total</span>
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>{task.stage}</div>
                        <div className="hint" style={{ margin: 0 }}>
                            Proofs are generated on your device (the very first transaction also
                            downloads one-time proving keys). Keep this window open — but feel free
                            to use the rest of the wallet; the bar at the bottom brings you back
                            here. It won't auto-lock while working.
                        </div>
                    </div>

                    {task.predictedAddress && (
                        <div className="card">
                            <div className="muted" style={{ marginBottom: 6 }}>
                                Your token's address (reserved)
                            </div>
                            <div className="address-mono" style={{ marginBottom: 8 }}>
                                {task.predictedAddress}
                            </div>
                            <button
                                className={`copy-btn ${copied ? "success" : ""}`}
                                style={{ width: "100%" }}
                                onClick={() => copy(task.predictedAddress!)}
                            >
                                {copied ? <CheckIcon /> : <CopyIcon />}
                                {copied ? "Copied" : "Copy address"}
                            </button>
                        </div>
                    )}
                </div>
            </>
        );
    }

    // ── result (kept until acknowledged, even across navigation) ────────────
    if (task?.phase === "done") {
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
                        <div style={{ fontWeight: 600, fontSize: 18 }}>Token deployed</div>
                        <div className="muted" style={{ marginTop: 4 }}>
                            {task.symbol} is live on {network.name}
                        </div>
                        <div style={{ marginTop: 6, display: "flex", justifyContent: "center" }}>
                            <ActualFeeRow feeJuice={task.feeJuice} />
                        </div>
                    </div>

                    <div className="card">
                        <div className="muted" style={{ marginBottom: 6 }}>
                            Contract address
                        </div>
                        <div className="address-mono" style={{ marginBottom: 8 }}>
                            {task.address}
                        </div>
                        <button
                            className={`copy-btn ${copied ? "success" : ""}`}
                            style={{ width: "100%" }}
                            onClick={() => copy(task.address)}
                        >
                            {copied ? <CheckIcon /> : <CopyIcon />}
                            {copied ? "Copied" : "Copy address"}
                        </button>
                    </div>

                    <div className="hint">
                        We've imported {task.symbol} into your token list. You can mint, send, and
                        receive it right away.
                    </div>

                    <button
                        className="btn btn-primary btn-block"
                        onClick={() => {
                            clearDeployTask();
                            onBack();
                        }}
                    >
                        Back to wallet
                    </button>
                </div>
            </>
        );
    }

    // ── form (idle, or showing a failure) ────────────────────────────────────
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

                <div style={{ fontWeight: 600, fontSize: 16 }}>Deploy a token</div>
                <p className="hint">
                    Mints a standard AIP-20 token on Aztec. Supports public + private balances,
                    shielding, and unshielding out of the box. You'll be the admin and (optionally)
                    the minter.
                </p>

                {task?.phase === "failed" && (
                    <div className="error">
                        Deploying {task.symbol} failed: {task.message}{" "}
                        <button className="muted" style={{ textDecoration: "underline" }} onClick={clearDeployTask}>
                            Dismiss
                        </button>
                    </div>
                )}

                <div className="field">
                    <label>Name</label>
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g. Acme Points"
                        maxLength={30}
                    />
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                    <div className="field" style={{ flex: 1 }}>
                        <label>Symbol</label>
                        <input
                            value={symbol}
                            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                            placeholder="ACME"
                            maxLength={8}
                            style={{ textTransform: "uppercase" }}
                        />
                    </div>
                    <div className="field" style={{ width: 96 }}>
                        <label>Decimals</label>
                        <input
                            value={decimals}
                            onChange={(e) => setDecimals(e.target.value)}
                            inputMode="numeric"
                        />
                    </div>
                </div>

                <div className="field">
                    <label>Initial supply (optional)</label>
                    <input
                        value={supply}
                        onChange={(e) => setSupply(e.target.value)}
                        placeholder="e.g. 1000000"
                        inputMode="decimal"
                    />
                </div>

                {supply.trim() && (
                    <div className="tabs fade-in">
                        <button
                            className={`tab ${supplyMode === "private" ? "active" : ""}`}
                            onClick={() => setSupplyMode("private")}
                        >
                            Mint privately
                        </button>
                        <button
                            className={`tab ${supplyMode === "public" ? "active" : ""}`}
                            onClick={() => setSupplyMode("public")}
                        >
                            Mint publicly
                        </button>
                    </div>
                )}

                <label
                    className="card"
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        cursor: "pointer",
                    }}
                >
                    <input
                        type="checkbox"
                        checked={keepMinter}
                        onChange={(e) => setKeepMinter(e.target.checked)}
                        style={{ width: "auto", margin: 0 }}
                    />
                    <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 500 }}>Keep minter role</div>
                        <div className="muted" style={{ marginTop: 2 }}>
                            You'll be able to mint more supply later. Uncheck to make the supply
                            permanently fixed.
                        </div>
                    </div>
                </label>

                {error && <div className="error">{error}</div>}

                {gasGate === "incoming" && (
                    <div className="card card-accent" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ fontWeight: 600 }}>Your gas is on the way</div>
                        <div className="hint" style={{ margin: 0 }}>
                            A bridge to this account is still landing — the gas usually becomes
                            usable within a few minutes, and this deploy will use it automatically.
                            Try again shortly.
                        </div>
                    </div>
                )}
                {gasGate === "none" && (
                    <div className="card card-accent" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ fontWeight: 600 }}>You need gas first</div>
                        <div className="hint" style={{ margin: 0 }}>
                            This account has no fee juice, and deploying a token needs some. Get
                            gas, wait for it to land, then deploy.
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
                )}

                {name.trim() && symbol.trim() && (
                    <FeeEstimateRow estimate={feeEst} firstTx={!account?.isDeployed} />
                )}

                <button className="btn btn-primary btn-block" disabled={checking} onClick={() => void deploy()}>
                    {checking ? "Checking…" : "Deploy token"}
                </button>
            </div>
        </>
    );
}
