import { useCallback, useEffect, useMemo, useState } from "react";
import { Header } from "../components/Header";
import { useWallet } from "../../lib/state/walletContext";
import {
    SANDBOX_L1_RPC_URL,
    SANDBOX_MINT_AMOUNT,
    bridgeFeeJuice,
    directRpcProvider,
    getInjectedProvider,
    listPendingBridges,
    type PendingBridge,
} from "../../lib/aztec/bridge";
import { formatUnits, parseUnits } from "../../lib/aztec/balances";

export function Bridge({ onBack }: { onBack: () => void }) {
    const { wallet, account, network } = useWallet();
    const isSandbox = network.id === "sandbox";
    const [amount, setAmount] = useState("0.05");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState<PendingBridge[]>([]);

    // Extension popups never get an injected provider (MetaMask only injects
    // into web pages). On sandbox we drive anvil directly — its accounts are
    // unlocked. On real networks an EIP-1193 wallet is required, which today
    // means bridging from a dapp page rather than inside the popup.
    const provider = useMemo(
        () => (isSandbox ? directRpcProvider(SANDBOX_L1_RPC_URL) : getInjectedProvider()),
        [isSandbox],
    );

    const refresh = useCallback(async () => {
        setPending(await listPendingBridges(network.id));
    }, [network.id]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    async function submit() {
        setError(null);
        if (!wallet || !account) return setError("Wallet not loaded.");
        if (!provider) return setError("No L1 wallet available for this network.");
        setBusy(true);
        try {
            // Sandbox: the L1 fee-asset handler mints a FIXED amount per call.
            const wei = isSandbox ? SANDBOX_MINT_AMOUNT : parseUnits(amount, 18);
            await bridgeFeeJuice({
                wallet,
                network,
                recipient: account.address,
                amount: wei,
                provider,
                // On sandbox the fee asset handler mints for the user. On real
                // networks the user must already hold the L1 fee juice token.
                mint: isSandbox,
            });
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Header />
            <div className="content">
                <button className="muted" style={{ alignSelf: "flex-start" }} onClick={onBack}>
                    ← Back
                </button>
                <div style={{ fontWeight: 600, fontSize: 16 }}>Bridge ETH → Fee Juice</div>
                <p className="hint">
                    Deposit on L1 to mint fee juice on L2 ({network.name}). After the L1 → L2
                    message lands, your next transaction consumes the claim as it pays gas.
                </p>

                {!isSandbox && (
                    <div className="card" style={{ borderColor: "var(--danger)" }}>
                        <div style={{ fontWeight: 600, marginBottom: 4 }}>
                            ⚠️ Bridging publicly links your identities
                        </div>
                        <div className="hint">
                            The deposit is a normal L1 transaction: anyone can see that your L1
                            address funded this Aztec address, permanently. If you care about that
                            link, fund from a fresh L1 address — or use the faucet instead, which
                            doesn't touch L1 from your wallet.
                        </div>
                    </div>
                )}

                {!provider && !isSandbox && (
                    <div className="card" style={{ borderColor: "var(--danger)" }}>
                        <div className="error">No L1 wallet available.</div>
                        <div className="hint" style={{ marginTop: 6 }}>
                            Browser-extension popups can't reach MetaMask. On {network.name}, use
                            the faucet to get fee juice, or bridge from a dapp page with your L1
                            wallet and send to your address here.
                        </div>
                    </div>
                )}

                {isSandbox ? (
                    <div className="field">
                        <label>Amount</label>
                        <div className="card" style={{ fontVariantNumeric: "tabular-nums" }}>
                            {formatUnits(SANDBOX_MINT_AMOUNT, 18)} JUICE
                            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                                Fixed by the sandbox's L1 fee-asset handler (mints exactly this per
                                call, no real ETH needed).
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="field">
                        <label>Amount (ETH-denominated fee juice)</label>
                        <input
                            inputMode="decimal"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                        />
                    </div>
                )}

                {error && <div className="error">{error}</div>}

                <button
                    className="btn btn-primary btn-block"
                    disabled={busy || !provider || (!isSandbox && !amount)}
                    onClick={submit}
                >
                    {busy ? "Bridging on L1…" : "Bridge"}
                </button>

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
                                    Posted {new Date(b.createdAt).toLocaleString()} · will auto-claim
                                    on your next outgoing transaction.
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </>
    );
}
