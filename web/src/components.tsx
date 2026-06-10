/** Shared chrome (header/footer/shell) + small UI atoms. NO wagmi in here —
 * this module is imported by /launch, which must ship zero L1 code. */

import { useState, type ReactNode } from "react";
import logoUrl from "./assets/fizzlogo.svg";
import { GITHUB_URL } from "./config";

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
                        No servers, no analytics — these pages talk only to the chains and (if installed) your Fizz wallet.
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
