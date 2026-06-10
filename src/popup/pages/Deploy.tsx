import { useEffect, useState } from "react";
import { Header } from "../components/Header";
import { ArrowLeftIcon, CheckIcon, CopyIcon } from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";
import { trackOp } from "../../lib/state/activity";
import {
    clearDeployJournal,
    recordDeployStart,
    recordLastLaunch,
    takeDeployDraft,
} from "../../lib/state/opJournal";
import { deployToken } from "../../lib/aztec/deploy";
import { addToken } from "../../lib/aztec/tokens";
import { parseUnits } from "../../lib/aztec/balances";

type Result = { address: string; txHash: string };

export function Deploy({ onBack }: { onBack: () => void }) {
    const { wallet, network, account, ensureAccountDeployed } = useWallet();

    const [name, setName] = useState("");
    const [symbol, setSymbol] = useState("");
    const [decimals, setDecimals] = useState("18");
    const [supply, setSupply] = useState("");
    const [supplyMode, setSupplyMode] = useState<"private" | "public">("private");
    const [keepMinter, setKeepMinter] = useState(true);

    const [busy, setBusy] = useState(false);
    const [stage, setStage] = useState<string | null>(null);
    const [startedAt, setStartedAt] = useState<number | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<Result | null>(null);
    const [copied, setCopied] = useState(false);

    // Draft hand-off: when the user jumps from the fragile toolbar popup to a
    // standalone window, their typed form follows them (one-shot).
    useEffect(() => {
        void takeDeployDraft().then((draft) => {
            if (!draft) return;
            setName(draft.name);
            setSymbol(draft.symbol);
            setDecimals(draft.decimals);
            setSupply(draft.supply);
            setSupplyMode(draft.supplyMode);
            setKeepMinter(draft.keepMinter);
        });
    }, []);

    // Visible elapsed clock while proving — minutes of silent "Deploying…"
    // read as a hang; a ticking timer reads as work.
    useEffect(() => {
        if (startedAt == null) return;
        const t = window.setInterval(
            () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
            1_000,
        );
        return () => window.clearInterval(t);
    }, [startedAt]);

    async function deploy() {
        setError(null);
        // Validate on click instead of disabling the button: a disabled button
        // swallows the click with zero feedback ("nothing happened").
        if (!name.trim() || !symbol.trim()) {
            return setError("Give your token a name and a symbol first.");
        }
        if (!wallet || !account) return setError("Wallet not loaded.");
        setBusy(true);
        setStartedAt(Date.now());
        setElapsed(0);
        try {
            // trackOp: defers the idle auto-lock — first-run proving (CRS
            // download + ClientIVC) can exceed the 5-min idle window while the
            // user just watches, and locking mid-flight kills the deploy.
            await trackOp(async () => {
                const d = Number(decimals);
                const supplyValue = supply.trim() ? parseUnits(supply, d) : 0n;
                if (!account.isDeployed) {
                    setStage("Activating your account (one-time)…");
                    await ensureAccountDeployed();
                }
                setStage("Proving + publishing the token…");
                const res = await deployToken({
                    wallet,
                    network,
                    deployer: account.address,
                    name: name.trim(),
                    symbol: symbol.trim().toUpperCase(),
                    decimals: d,
                    initialSupply: supplyValue,
                    initialSupplyMode: supplyMode,
                    keepMinterRole: keepMinter,
                    // Crash journal: the deploy address is deterministic and
                    // known pre-send. If this page dies mid-flight (popup
                    // closed on blur), the next session probes the chain for
                    // it and recovers the token or explains the interruption.
                    onPredictedAddress: (address) =>
                        recordDeployStart({
                            predictedAddress: address,
                            name: name.trim(),
                            symbol: symbol.trim().toUpperCase(),
                            decimals: d,
                            networkId: network.id,
                            hadInitialSupply: supplyValue > 0n,
                            startedAt: Date.now(),
                        }),
                });
                const addrStr = res.address.toString();
                await addToken(network.id, {
                    address: addrStr,
                    symbol: symbol.trim().toUpperCase(),
                    name: name.trim(),
                    decimals: d,
                });
                await clearDeployJournal();
                // /launch round-trip: the page that initiated this (if any)
                // polls the background for the public result.
                await recordLastLaunch({
                    address: addrStr,
                    txHash: res.txHash,
                    name: name.trim(),
                    symbol: symbol.trim().toUpperCase(),
                    at: Date.now(),
                });
                setResult({ address: addrStr, txHash: res.txHash });
            });
        } catch (e) {
            // The failure is visible on screen — the journal would only
            // produce a stale "interrupted" banner next session.
            await clearDeployJournal();
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
            setStage(null);
            setStartedAt(null);
        }
    }

    async function copyAddress() {
        if (!result) return;
        await navigator.clipboard.writeText(result.address);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    if (result) {
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
                            {symbol.toUpperCase()} is live on {network.name}
                        </div>
                    </div>

                    <div className="card">
                        <div className="muted" style={{ marginBottom: 6 }}>
                            Contract address
                        </div>
                        <div className="address-mono" style={{ marginBottom: 8 }}>
                            {result.address}
                        </div>
                        <button
                            className={`copy-btn ${copied ? "success" : ""}`}
                            style={{ width: "100%" }}
                            onClick={copyAddress}
                        >
                            {copied ? <CheckIcon /> : <CopyIcon />}
                            {copied ? "Copied" : "Copy address"}
                        </button>
                    </div>

                    <div className="hint">
                        We've imported {symbol.toUpperCase()} into your token list — you can mint,
                        send, and receive it right away.
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

                <div style={{ fontWeight: 600, fontSize: 16 }}>Deploy a token</div>
                <p className="hint">
                    Mints a standard AIP-20 token on Aztec — supports public + private balances,
                    shielding, and unshielding out of the box. You'll be the admin and (optionally)
                    the minter.
                </p>

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

                <button className="btn btn-primary btn-block" disabled={busy} onClick={deploy}>
                    {busy ? stage ?? "Deploying…" : "Deploy token"}
                </button>

                {busy && (
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
                        <div className="hint" style={{ margin: 0 }}>
                            Proofs are generated on your device (the very first transaction also
                            downloads one-time proving keys). Keep this window open until you see
                            the confirmation — it won't auto-lock while working.
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}
