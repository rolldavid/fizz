import { useCallback, useEffect, useMemo, useState } from "react";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Header } from "../components/Header";
import { ArrowLeftIcon } from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";
import { loadTokens, type TokenEntry } from "../../lib/aztec/tokens";
import { parseUnits } from "../../lib/aztec/balances";
import { getMintAuthority, mintToken, type MintAuthority } from "../../lib/aztec/mint";

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
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<{ txHash: string } | null>(null);

    useEffect(() => {
        loadTokens(network.id).then((list) => {
            const real = list.filter((t) => t.kind !== "fee_juice");
            setTokens(real);
            if (real[0]) setTokenAddr(real[0].address);
        });
    }, [network.id]);

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
            setAuthError(e instanceof Error ? e.message : String(e));
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
        if (!wallet) return setError("Wallet not loaded.");
        if (!account) return setError("Account not loaded.");
        if (!token) return setError("Pick a token.");
        setBusy(true);
        try {
            const value = parseUnits(amount, token.decimals);
            const recipient = toSelf ? account.address : AztecAddress.fromString(to.trim());
            if (!account.isDeployed) {
                await ensureAccountDeployed();
            }
            const result = await mintToken({
                wallet,
                network,
                minter: account.address,
                tokenAddress: AztecAddress.fromString(token.address),
                to: recipient,
                amount: value,
                mode,
            });
            setDone({ txHash: result.txHash });
            setAmount("");
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    const canMint = authority?.isMinter === true;

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
                    Creates new supply on a token where you hold the minter role — directly into a
                    private or public balance.
                </p>

                <div className="field">
                    <label>Token</label>
                    <select value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value)}>
                        {tokens.length === 0 && <option value="">No tokens imported</option>}
                        {tokens.map((t) => (
                            <option key={t.address} value={t.address}>
                                {t.symbol} — {t.name}
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
                            ? " — but you're the admin, so you can grant it to yourself from the token's management tools."
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
                                ? "Minted privately — the new supply appears only in the recipient's private balance."
                                : "Minted publicly — the new supply is visible on-chain in the recipient's public balance."}
                        </div>

                        {error && <div className="error">{error}</div>}

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
                            </div>
                        )}

                        <button
                            className="btn btn-primary btn-block"
                            disabled={busy || !token || !amount || (!toSelf && !to)}
                            onClick={submit}
                        >
                            {busy ? "Proving + minting…" : "Mint"}
                        </button>
                        {busy && (
                            <div className="hint">
                                Proof generation runs locally in your browser — this can take a little
                                while.
                            </div>
                        )}
                    </>
                )}
            </div>
        </>
    );
}
