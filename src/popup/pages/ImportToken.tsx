import { useEffect, useMemo, useState } from "react";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Header } from "../components/Header";
import { ArrowLeftIcon } from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";
import { addToken } from "../../lib/aztec/tokens";
import { fetchTokenMetadata, type TokenMetadata } from "../../lib/aztec/balances";

/**
 * Import a token by contract address. Name, symbol and decimals are read from
 * the contract automatically (the standard Token's public_get_* views), so the
 * user only ever types the address. Registering the instance with the bundled
 * Token artifact also validates that the address is a real Aztec token.
 */
export function ImportToken({ onBack }: { onBack: () => void }) {
    const { wallet, account, network } = useWallet();
    const [address, setAddress] = useState("");
    const [meta, setMeta] = useState<TokenMetadata | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [added, setAdded] = useState(false);

    const canonical = useMemo(() => {
        try {
            return AztecAddress.fromString(address.trim()).toString();
        } catch {
            return null;
        }
    }, [address]);

    // Auto-resolve metadata once the address is valid.
    useEffect(() => {
        setMeta(null);
        setError(null);
        if (!canonical || !wallet || !account) return;
        let cancelled = false;
        setBusy(true);
        fetchTokenMetadata(wallet, AztecAddress.fromString(canonical), account.address)
            .then((m) => !cancelled && setMeta(m))
            .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
            .finally(() => !cancelled && setBusy(false));
        return () => {
            cancelled = true;
        };
    }, [canonical, wallet, account]);

    async function add() {
        if (!canonical || !meta) return;
        setError(null);
        try {
            await addToken(network.id, {
                address: canonical,
                symbol: meta.symbol,
                name: meta.name,
                decimals: meta.decimals,
            });
            setAdded(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
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

                <div style={{ fontWeight: 600, fontSize: 16 }}>Import a token</div>
                <p className="hint">
                    Paste the token's contract address. Fizz reads its name, symbol and decimals
                    straight from the contract.
                </p>

                <div className="field">
                    <label>Contract address</label>
                    <input
                        value={address}
                        onChange={(e) => {
                            setAddress(e.target.value);
                            setAdded(false);
                        }}
                        placeholder="0x…"
                        style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
                        spellCheck={false}
                        autoComplete="off"
                        autoFocus
                    />
                </div>

                {busy && <div className="hint">Looking up the token…</div>}

                {meta && (
                    <div className="card" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div className="token-glyph">{meta.symbol.slice(0, 2).toUpperCase()}</div>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>
                                {meta.symbol} <span className="muted">· {meta.decimals} decimals</span>
                            </div>
                            <div className="muted" style={{ fontSize: 12 }}>{meta.name}</div>
                        </div>
                    </div>
                )}

                {error && <div className="error">{error}</div>}

                {added ? (
                    <>
                        <div className="card" style={{ borderColor: "var(--success)" }}>
                            <div style={{ color: "var(--success)", fontWeight: 500 }}>
                                ✓ {meta?.symbol} imported
                            </div>
                            <div className="hint" style={{ marginTop: 4 }}>
                                It now shows in your token list (private + public).
                            </div>
                        </div>
                        <button className="btn btn-primary btn-block" onClick={onBack}>
                            Back to wallet
                        </button>
                    </>
                ) : (
                    <button className="btn btn-primary btn-block" disabled={busy || !meta} onClick={add}>
                        {meta ? `Add ${meta.symbol}` : "Add token"}
                    </button>
                )}
            </div>
        </>
    );
}
