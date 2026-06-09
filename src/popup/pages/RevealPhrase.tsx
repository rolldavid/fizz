/**
 * Reveal / export recovery material.
 *
 * Lets an unlocked user retrieve their 12-word recovery phrase (and, advanced,
 * the raw account secret) AFTER a fresh re-authentication — biometric/PIN for a
 * passkey vault, or re-entering the passphrase. This is the path a passkey user
 * uses to back up their words so they can restore on another device or recover
 * if they lose the passkey.
 *
 * Security: we re-auth by re-decrypting the vault (vaultStore.unlock*), not by
 * reading the in-memory secret, so the authenticator/passphrase gate is real.
 * The revealed material lives only in this component's state and is dropped when
 * the page unmounts.
 */
import { useEffect, useRef, useState } from "react";
import { vaultStore, type RevealedSecret } from "../../lib/vault/store";
import { exportAccountSecretHex } from "../../lib/aztec/wallet";
import { ArrowLeftIcon, CheckIcon, CopyIcon } from "../components/icons";

type Revealed = { words: string[]; secretHex: string };

/** Best-effort clipboard wipe delay after copying secret material. */
const CLIPBOARD_CLEAR_MS = 30_000;

export function RevealPhrase({ onBack }: { onBack: () => void }) {
    const method = vaultStore.method();
    const [passphrase, setPassphrase] = useState("");
    const [revealed, setRevealed] = useState<Revealed | null>(null);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState<"phrase" | "key" | null>(null);
    const clearTimer = useRef<number | undefined>(undefined);
    const lastCopied = useRef<string | null>(null);

    // Drop the revealed secret from memory when leaving the page.
    useEffect(() => () => setRevealed(null), []);
    useEffect(() => () => window.clearTimeout(clearTimer.current), []);

    async function doReveal(fn: () => Promise<RevealedSecret>) {
        setError(null);
        setBusy(true);
        try {
            const secret = await fn();
            const secretHex = await exportAccountSecretHex(secret.seed, 0);
            setRevealed({ words: secret.mnemonic.split(/\s+/), secretHex });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    async function copy(text: string, which: "phrase" | "key") {
        await navigator.clipboard.writeText(text);
        setCopied(which);
        lastCopied.current = text;
        setTimeout(() => setCopied(null), 1500);
        // Best-effort wipe: clears OUR secret from the clipboard after 30s
        // unless the user has copied something else since. Cannot defeat
        // clipboard managers / OS cloud sync — the on-screen warning is the
        // real control.
        window.clearTimeout(clearTimer.current);
        clearTimer.current = window.setTimeout(async () => {
            try {
                const current = await navigator.clipboard.readText().catch(() => null);
                if (current === null || current === lastCopied.current) {
                    await navigator.clipboard.writeText("");
                }
            } catch {
                // Clipboard access denied (popup unfocused) — nothing we can do.
            }
        }, CLIPBOARD_CLEAR_MS);
    }

    return (
        <>
            <div className="header">
                <button className="icon-btn" onClick={onBack} aria-label="Back">
                    <ArrowLeftIcon />
                </button>
                <div className="brand" style={{ fontSize: 15 }}>
                    Recovery phrase
                </div>
                <div style={{ width: 28 }} />
            </div>
            <div className="content">
                {!revealed && (
                    <>
                        <div className="card" style={{ borderColor: "var(--danger)" }}>
                            <div style={{ fontWeight: 600, marginBottom: 6 }}>
                                Reveal your secret recovery phrase
                            </div>
                            <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                                Anyone who sees these 12 words can take your funds. Make sure no one
                                is watching your screen and you're not being recorded.
                            </div>
                        </div>

                        {method === "passkey" && (
                            <button
                                className="btn btn-primary btn-block"
                                disabled={busy}
                                onClick={() => doReveal(() => vaultStore.unlockWithPasskey())}
                            >
                                {busy ? "Waiting for passkey…" : "Verify with passkey to reveal"}
                            </button>
                        )}
                        {method === "passphrase" && (
                            <>
                                <div className="field">
                                    <label>Enter your passphrase to reveal</label>
                                    <input
                                        type="password"
                                        value={passphrase}
                                        onChange={(e) => setPassphrase(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" && passphrase)
                                                doReveal(() =>
                                                    vaultStore.unlockWithPassphrase(passphrase),
                                                );
                                        }}
                                    />
                                </div>
                                <button
                                    className="btn btn-primary btn-block"
                                    disabled={busy || !passphrase}
                                    onClick={() =>
                                        doReveal(() => vaultStore.unlockWithPassphrase(passphrase))
                                    }
                                >
                                    {busy ? "Verifying…" : "Reveal"}
                                </button>
                            </>
                        )}
                        {error && <div className="error">{error}</div>}
                    </>
                )}

                {revealed && (
                    <>
                        <p className="hint">
                            Write these 12 words down in order. Importing them into a fresh install
                            of this wallet — on any device — restores this exact account.
                        </p>
                        <div className="mnemonic-grid">
                            {revealed.words.map((w, i) => (
                                <div key={i} className="mnemonic-word">
                                    {i + 1}. {w}
                                </div>
                            ))}
                        </div>
                        <button
                            className="btn btn-ghost btn-block"
                            onClick={() => copy(revealed.words.join(" "), "phrase")}
                        >
                            {copied === "phrase" ? <CheckIcon /> : <CopyIcon />}{" "}
                            {copied === "phrase" ? "Copied — clears in 30s" : "Copy phrase"}
                        </button>
                        <div className="hint" style={{ fontSize: 11 }}>
                            ⚠️ Copying puts the phrase on your system clipboard, where other apps,
                            clipboard managers, and OS clipboard sync can read it. Writing the words
                            down by hand is safer. We auto-clear the clipboard after 30 seconds.
                        </div>

                        <button
                            className="btn btn-ghost btn-block"
                            style={{ fontSize: 12, marginTop: 4 }}
                            onClick={() => setShowAdvanced((s) => !s)}
                        >
                            {showAdvanced ? "Hide" : "Show"} advanced: account key
                        </button>
                        {showAdvanced && (
                            <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>
                                    Raw account secret. Recover this account in the official Aztec
                                    CLI with{" "}
                                    <code style={{ fontSize: 10 }}>
                                        aztec-wallet create-account --secret-key &lt;key&gt;
                                    </code>{" "}
                                    (deploy salt is 0). Treat it like the phrase — it controls your
                                    funds.
                                </div>
                                <div
                                    style={{
                                        fontFamily: "ui-monospace, monospace",
                                        fontSize: 11,
                                        wordBreak: "break-all",
                                        background: "var(--bg-subtle, rgba(127,127,127,0.1))",
                                        padding: 8,
                                        borderRadius: 6,
                                    }}
                                >
                                    {revealed.secretHex}
                                </div>
                                <button
                                    className="btn btn-ghost"
                                    style={{ fontSize: 11 }}
                                    onClick={() => copy(revealed.secretHex, "key")}
                                >
                                    {copied === "key" ? "Copied" : "Copy account key"}
                                </button>
                            </div>
                        )}

                        <button
                            className="btn btn-primary btn-block"
                            style={{ marginTop: 8 }}
                            onClick={() => {
                                setRevealed(null);
                                setShowAdvanced(false);
                                onBack();
                            }}
                        >
                            Done — hide
                        </button>
                    </>
                )}
            </div>
        </>
    );
}
