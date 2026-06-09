import { useCallback, useEffect, useState } from "react";
import { Header, shortAddress } from "../components/Header";
import { CheckIcon, CopyIcon } from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";
import { trackOp } from "../../lib/state/activity";
import {
    SANDBOX_L1_RPC_URL,
    SANDBOX_MINT_AMOUNT,
    bridgeFeeJuice,
    directRpcProvider,
    listPendingBridges,
    type PendingBridge,
} from "../../lib/aztec/bridge";
import {
    bridgeFromFundingAccount,
    getL1FundingStatus,
    type L1FundingStatus,
} from "../../lib/aztec/l1Funding";
import { formatUnits, parseUnits } from "../../lib/aztec/balances";

/**
 * Bridge: get fee juice (gas) onto L2.
 *
 * Sandbox  → one click; anvil's unlocked accounts pay, the handler mints.
 * Testnet+ → the wallet's own L1 FUNDING ACCOUNT (derived from your phrase at
 *            the standard Ethereum path — restorable in MetaMask):
 *              1. user sends a little Sepolia ETH to the funding address
 *              2. "Get free JUICE" mints a fixed batch via the network handler
 *                 (gas-only), or bridges their own AZTEC balance
 *              3. the claim auto-pays their next Fizz transaction
 */
export function Bridge({ onBack }: { onBack: () => void }) {
    const { wallet, account, network } = useWallet();
    const isSandbox = network.id === "sandbox";
    const [busy, setBusy] = useState(false);
    const [stage, setStage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [pending, setPending] = useState<PendingBridge[]>([]);
    const [funding, setFunding] = useState<L1FundingStatus | null>(null);
    const [fundingError, setFundingError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [assetAmount, setAssetAmount] = useState("");

    const refresh = useCallback(async () => {
        // Every failure path must land in visible state — anything that escapes
        // here dies as an unhandled rejection and leaves the card spinning
        // forever (the exact bug this replaced).
        try {
            setPending(await listPendingBridges(network.id));
        } catch (e) {
            setFundingError(e instanceof Error ? e.message : String(e));
            return;
        }
        if (!isSandbox && wallet) {
            try {
                setFundingError(null);
                setFunding(await getL1FundingStatus(wallet, network));
            } catch (e) {
                setFundingError(e instanceof Error ? e.message : String(e));
            }
        }
    }, [network, wallet, isSandbox]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const hasGas = (funding?.eth ?? 0n) > 2_000_000_000_000_000n; // ~0.002 ETH
    const hasAsset = (funding?.feeAsset ?? 0n) > 0n;

    async function run(fn: () => Promise<unknown>) {
        setError(null);
        setDone(false);
        setBusy(true);
        try {
            // trackOp: L1 txs + confirmation waits can outlast the idle window;
            // don't let the auto-lock kill a bridge mid-deposit.
            await trackOp(fn);
            setDone(true);
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
            setStage(null);
        }
    }

    function sandboxBridge() {
        if (!wallet || !account) return setError("Wallet not loaded.");
        return run(async () => {
            setStage("Minting + depositing on local L1…");
            await bridgeFeeJuice({
                wallet,
                network,
                recipient: account.address,
                amount: SANDBOX_MINT_AMOUNT,
                provider: directRpcProvider(SANDBOX_L1_RPC_URL),
                mint: true,
            });
        });
    }

    function mintBridge() {
        if (!wallet || !account) return setError("Wallet not loaded.");
        return run(async () => {
            setStage("Minting free JUICE + depositing on L1 (two txs)…");
            await bridgeFromFundingAccount({
                wallet,
                network,
                recipient: account.address,
                mode: "mint",
            });
        });
    }

    function assetBridge() {
        if (!wallet || !account) return setError("Wallet not loaded.");
        return run(async () => {
            const amount = parseUnits(assetAmount, 18);
            setStage(`Approving + depositing ${assetAmount} ${funding?.feeAssetSymbol ?? "AZTEC"}…`);
            await bridgeFromFundingAccount({
                wallet,
                network,
                recipient: account.address,
                mode: "asset",
                amount,
            });
        });
    }

    async function copyFunding() {
        if (!funding) return;
        await navigator.clipboard.writeText(funding.address);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    return (
        <>
            <Header />
            <div className="content">
                <button className="muted" style={{ alignSelf: "flex-start" }} onClick={onBack}>
                    ← Back
                </button>
                <div style={{ fontWeight: 600, fontSize: 16 }}>Get fee juice (gas)</div>

                {isSandbox ? (
                    <>
                        <p className="hint">
                            One click — the local L1 mints a fixed batch and deposits it to your
                            account. Your next transaction claims it automatically.
                        </p>
                        <button
                            className="btn btn-primary btn-block"
                            disabled={busy}
                            onClick={sandboxBridge}
                        >
                            {busy ? stage ?? "Bridging…" : `Get ${formatUnits(SANDBOX_MINT_AMOUNT, 18)} JUICE`}
                        </button>
                    </>
                ) : (
                    <>
                        <p className="hint">
                            Fizz has its own L1 funding address, made from your recovery phrase
                            (standard Ethereum derivation — the same 12 words restore it in
                            MetaMask too). Fund it once, bridge whenever you need gas.
                        </p>

                        {/* Step 1 — funding address + balances */}
                        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <div className="muted">Step 1 · Your L1 funding address (Sepolia)</div>
                            {fundingError && <div className="error">{fundingError}</div>}
                            {funding && (
                                <>
                                    <div
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 8,
                                            justifyContent: "space-between",
                                        }}
                                    >
                                        <span
                                            style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
                                            title={funding.address}
                                        >
                                            {shortAddress(funding.address, 10, 8)}
                                        </span>
                                        <button className="icon-btn" onClick={copyFunding} title="Copy">
                                            {copied ? <CheckIcon /> : <CopyIcon />}
                                        </button>
                                    </div>
                                    <div style={{ display: "flex", gap: 14, fontVariantNumeric: "tabular-nums" }}>
                                        <span className={hasGas ? "" : "muted"}>
                                            ⛽ {funding.ethFormatted} ETH
                                        </span>
                                        <span className={hasAsset ? "" : "muted"}>
                                            🫧 {funding.feeAssetFormatted} {funding.feeAssetSymbol}
                                        </span>
                                    </div>
                                    {!hasGas && (
                                        <div className="hint">
                                            Send ~0.01 Sepolia ETH here first (it pays the L1 gas).
                                            For best privacy fund it from an exchange withdrawal, not
                                            a wallet that's publicly you.
                                        </div>
                                    )}
                                </>
                            )}
                            {!funding && !fundingError && (
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <span className="spinner" />
                                    <span className="muted" style={{ fontSize: 12 }}>
                                        {wallet
                                            ? "Reading L1 balances…"
                                            : "Waiting for the network connection…"}
                                    </span>
                                </div>
                            )}
                        </div>

                        {/* Step 2 — bridge */}
                        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <div className="muted">Step 2 · Bridge to your Fizz account</div>
                            {funding?.canMint && (
                                <button
                                    className="btn btn-primary btn-block"
                                    disabled={busy || !hasGas}
                                    onClick={mintBridge}
                                    title={hasGas ? "" : "Needs Sepolia ETH for gas first"}
                                >
                                    {busy && stage?.startsWith("Minting")
                                        ? stage
                                        : `Get ${formatUnits(SANDBOX_MINT_AMOUNT, 18)} free testnet JUICE`}
                                </button>
                            )}
                            {hasAsset && (
                                <>
                                    <div className="field">
                                        <label>
                                            Or bridge your own {funding?.feeAssetSymbol} (balance:{" "}
                                            {funding?.feeAssetFormatted})
                                        </label>
                                        <input
                                            inputMode="decimal"
                                            value={assetAmount}
                                            onChange={(e) => setAssetAmount(e.target.value)}
                                            placeholder="100"
                                        />
                                    </div>
                                    <button
                                        className="btn btn-ghost btn-block"
                                        disabled={busy || !hasGas || !assetAmount.trim()}
                                        onClick={assetBridge}
                                    >
                                        {busy && stage?.startsWith("Approving")
                                            ? stage
                                            : `Bridge ${funding?.feeAssetSymbol ?? "AZTEC"} → JUICE`}
                                    </button>
                                </>
                            )}
                            <div className="hint" style={{ fontSize: 11 }}>
                                ⚠️ Bridging is a public L1 action: anyone can see this L1 address
                                funded your Aztec address. ~2.3 JUICE ≈ one transaction.
                            </div>
                        </div>
                    </>
                )}

                {error && <div className="error">{error}</div>}
                {done && (
                    <div className="card" style={{ borderColor: "var(--success)" }}>
                        <div style={{ color: "var(--success)", fontWeight: 500 }}>
                            ✓ Deposit sent
                        </div>
                        <div className="hint" style={{ marginTop: 4 }}>
                            The claim lands on L2 in a few minutes and your next transaction uses
                            it automatically — nothing else to do.
                        </div>
                    </div>
                )}

                {pending.length > 0 && (
                    <div>
                        <div className="muted" style={{ marginBottom: 8 }}>
                            Pending claims
                        </div>
                        {pending.map((b) => (
                            <div key={b.id} className="card" style={{ marginBottom: 8 }}>
                                <div style={{ fontWeight: 500 }}>
                                    {formatUnits(BigInt(b.claimAmount), 18)} JUICE
                                </div>
                                <div className="muted" style={{ fontSize: 11 }}>
                                    Posted {new Date(b.createdAt).toLocaleString()} · auto-claims on
                                    your next outgoing transaction.
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </>
    );
}
