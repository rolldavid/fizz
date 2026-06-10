/** Shared chrome (Layout: nav + footer + <Outlet/>) and small UI atoms for the
 *  fizzwallet.com SPA. The nav carries BOTH wallet connections, site-wide:
 *  the Aztec (Fizz) chip and the Ethereum (MetaMask/Rabby) chip. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import logoUrl from "./assets/fizzlogo.svg";
import { CHROME_STORE_URL, GITHUB_URL } from "./config";
import { useConnection } from "./connection";

/**
 * Context-aware Aztec-wallet button: Install Wallet (no extension / mobile /
 * non-Chromium) → Connect Wallet (installed, not connected) → "Aztec Wallet"
 * chip with a disconnect dropdown (connected). Address-blind: the chip never
 * shows an address — we don't learn it. Labelled "Aztec Wallet" so it's clearly
 * distinct from the Ethereum wallet.
 */
function NavWalletButton() {
    const { platform, status, connecting, connect, disconnect } = useConnection();
    const [menuOpen, setMenuOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!menuOpen) return;
        const onDoc = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
    }, [menuOpen]);

    if (status === "connected") {
        return (
            <div className="wallet-chip" ref={wrapRef}>
                <button
                    type="button"
                    className="install-btn wallet-connected"
                    onClick={() => setMenuOpen((o) => !o)}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    title="Aztec wallet connected"
                >
                    <span className="conn-dot" /> Aztec Wallet <span className="chip-caret">▾</span>
                </button>
                {menuOpen && (
                    <div className="wallet-menu" role="menu">
                        <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                setMenuOpen(false);
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
    if (platform.canUseExtension && status === "disconnected") {
        return (
            <button type="button" className="install-btn" disabled={connecting} onClick={() => void connect()}>
                {connecting ? "Connecting…" : "Connect Wallet"}
            </button>
        );
    }
    if (platform.canUseExtension && status === "checking") {
        return <span className="install-btn install-btn-muted">Wallet…</span>;
    }
    // Not installed, mobile, or non-Chromium → point at the store.
    return (
        <a className="install-btn" href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer">
            Install Wallet
        </a>
    );
}

/** App shell: sticky nav (logo + links + both wallet chips) and footer, with the
 *  active route rendered through <Outlet/>. Connection state lives above this in
 *  the providers, so it persists across client-side navigation. */
export function Layout() {
    return (
        <>
            <div className="bubbles" aria-hidden="true">
                <span></span><span></span><span></span><span></span><span></span><span></span><span></span>
            </div>
            <div className="wrap">
                <header className="site-header">
                    <Link className="logo-link" to="/" aria-label="Fizz — home">
                        <img className="logo" src={logoUrl} alt="Fizz" />
                    </Link>
                    <nav className="site-nav">
                        <NavLink to="/bridge">Get Gas</NavLink>
                        <NavLink to="/launch">Launch a Token</NavLink>
                        {/* Aztec wallet only — the Ethereum connect lives on /bridge. */}
                        <NavWalletButton />
                    </nav>
                </header>
                <main>
                    <Outlet />
                </main>
                <footer className="site-footer">
                    <p>
                        <Link to="/">fizzwallet.com</Link>
                        <span className="sep">·</span>
                        <Link to="/bridge">Bridge fee juice</Link>
                        <span className="sep">·</span>
                        <Link to="/launch">Launch a token</Link>
                        <span className="sep">·</span>
                        <a href="/privacy">Privacy</a>
                        <span className="sep">·</span>
                        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                            GitHub
                        </a>
                    </p>
                    <p className="small" style={{ marginTop: 8 }}>
                        Fizz runs no servers and no analytics of its own. Each page lists exactly which networks
                        and services it contacts.
                    </p>
                </footer>
            </div>
        </>
    );
}

export function ErrorBox({ title, children }: { title?: string; children: ReactNode }) {
    return (
        <div className="error-box" role="alert">
            <span className="error-title">{title ?? "Something went wrong"}</span>
            {children}
        </div>
    );
}

/** Clipboard write with surfaced failure (no silent no-op). */
export function CopyButton({ text, label }: { text: string; label?: string }) {
    const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
    async function copy() {
        try {
            await navigator.clipboard.writeText(text);
            setState("copied");
        } catch {
            setState("failed");
        }
        setTimeout(() => setState("idle"), 1800);
    }
    return (
        <button type="button" className="btn btn-ghost btn-small" onClick={() => void copy()}>
            {state === "idle" && (label ?? "Copy")}
            {state === "copied" && "Copied ✓"}
            {state === "failed" && "Copy failed — select manually"}
        </button>
    );
}

export function shortHex(value: string, head = 10, tail = 6): string {
    return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * Shown in place of wallet-connect UI when the extension can't run here:
 * mobile (no extension support) or a non-Chromium desktop browser (Firefox
 * build is planned). Best-practice dead-end avoidance — explain why and what
 * to do, and on mobile offer a copy-link so they can reopen on desktop.
 */
export function DesktopRequiredNotice({ reason }: { reason: "mobile" | "non-chromium" }) {
    const url = typeof window !== "undefined" ? window.location.href : "https://fizzwallet.com/";
    return (
        <div className="desktop-required" role="status">
            <div className="dr-emoji" aria-hidden="true">
                🖥️
            </div>
            {reason === "mobile" ? (
                <>
                    <h3>Open Fizz on desktop</h3>
                    <p>
                        Fizz is a browser-extension wallet, so it runs in a{" "}
                        <strong>desktop Chromium browser</strong> — Chrome, Brave, Edge, or Arc. Mobile
                        browsers can't add extensions, so connecting a wallet is disabled here. Open this
                        page on your computer to install and use Fizz.
                    </p>
                    <CopyButton text={url} label="Copy this link" />
                </>
            ) : (
                <>
                    <h3>Use a Chromium browser</h3>
                    <p>
                        Fizz currently supports <strong>Chromium browsers</strong> — Chrome, Brave, Edge,
                        or Arc. A Firefox build is on the way. Switch to a Chromium browser to install and
                        connect Fizz.
                    </p>
                </>
            )}
        </div>
    );
}
