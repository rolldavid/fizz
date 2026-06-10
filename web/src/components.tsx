/** Shared chrome (header/footer/shell) + small UI atoms. NO wagmi in here —
 * this module is imported by /launch, which must ship zero L1 code. */

import { useState, type ReactNode } from "react";
import logoUrl from "./assets/fizzlogo.svg";
import { CHROME_STORE_URL, GITHUB_URL } from "./config";

export function Shell({ page, children }: { page: "bridge" | "launch"; children: ReactNode }) {
    return (
        <>
            <div className="bubbles" aria-hidden="true">
                <span></span><span></span><span></span><span></span><span></span><span></span><span></span>
            </div>
            <div className="wrap">
                <header className="site-header">
                    <a className="logo-link" href="/" title="Fizz — home">
                        <img className="logo" src={logoUrl} alt="Fizz" />
                    </a>
                    <nav className="site-nav">
                        <a href="/bridge/" aria-current={page === "bridge" ? "page" : undefined}>Bridge</a>
                        <a href="/launch/" aria-current={page === "launch" ? "page" : undefined}>Launch</a>
                        <a
                            className="install-btn"
                            href={CHROME_STORE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Install Wallet
                        </a>
                    </nav>
                </header>
                <main>{children}</main>
                <footer className="site-footer">
                    <p>
                        <a href="/">fizzwallet.com</a>
                        <span className="sep">·</span>
                        <a href="/bridge/">Bridge fee juice</a>
                        <span className="sep">·</span>
                        <a href="/launch/">Launch a token</a>
                        <span className="sep">·</span>
                        <a href="/privacy.html">Privacy</a>
                        <span className="sep">·</span>
                        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
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
