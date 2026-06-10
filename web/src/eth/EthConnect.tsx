/**
 * Nav control for the Ethereum wallet — MetaMask + Rabby only, address-blind in
 * the UI (the chip shows "Ethereum", never the address). Mirrors the Aztec
 * wallet chip's look. Rendered site-wide on desktop-Chromium (where both wallets
 * can run); hidden on mobile/non-Chromium, where the Aztec button steers people
 * to a supported browser instead.
 */
import { useEffect, useRef, useState } from "react";
import { useEth } from "./EthProvider";

const METAMASK_URL = "https://metamask.io/download/";
const RABBY_URL = "https://rabby.io/";

export function EthConnect() {
    const { ready, status, walletName, wallets, connect, disconnect } = useEth();
    const [open, setOpen] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const wrapRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
        };
        const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
        document.addEventListener("mousedown", onDoc);
        document.addEventListener("keydown", onEsc);
        return () => {
            document.removeEventListener("mousedown", onDoc);
            document.removeEventListener("keydown", onEsc);
        };
    }, [open]);

    if (status === "connected") {
        return (
            <div className="wallet-chip" ref={wrapRef}>
                <button
                    type="button"
                    className="eth-btn eth-connected"
                    onClick={() => setOpen((o) => !o)}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    title={walletName ? `${walletName} connected` : "Ethereum wallet connected"}
                >
                    <span className="conn-dot eth-dot" /> Ethereum <span className="chip-caret">▾</span>
                </button>
                {open && (
                    <div className="wallet-menu" role="menu">
                        <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                setOpen(false);
                                void disconnect();
                            }}
                        >
                            Disconnect
                        </button>
                    </div>
                )}
            </div>
        );
    }

    async function pick(id: string) {
        setError(null);
        setBusyId(id);
        try {
            await connect(id);
            setOpen(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusyId(null);
        }
    }

    return (
        <div className="wallet-chip" ref={wrapRef}>
            <button
                type="button"
                className="eth-btn"
                disabled={status === "connecting"}
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
            >
                {status === "connecting" ? "Connecting…" : "Connect Ethereum"}{" "}
                <span className="chip-caret">▾</span>
            </button>
            {open && (
                <div className="wallet-menu wallet-menu-wide" role="menu">
                    {!ready ? (
                        <div className="wallet-menu-note">Detecting wallets…</div>
                    ) : wallets.length > 0 ? (
                        wallets.map((w) => (
                            <button
                                key={w.id}
                                type="button"
                                role="menuitem"
                                disabled={busyId !== null}
                                onClick={() => void pick(w.id)}
                            >
                                {w.icon && <img src={w.icon} alt="" className="wallet-ic" />}
                                {busyId === w.id ? "Connecting…" : w.name}
                            </button>
                        ))
                    ) : (
                        <>
                            <div className="wallet-menu-note">No MetaMask or Rabby found.</div>
                            <a className="wallet-menu-link" href={METAMASK_URL} target="_blank" rel="noopener noreferrer">
                                Install MetaMask ↗
                            </a>
                            <a className="wallet-menu-link" href={RABBY_URL} target="_blank" rel="noopener noreferrer">
                                Install Rabby ↗
                            </a>
                        </>
                    )}
                    {error && <div className="wallet-menu-err">{error}</div>}
                </div>
            )}
        </div>
    );
}
