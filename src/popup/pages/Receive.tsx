import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Header, shortAddress } from "../components/Header";
import { Identicon } from "../components/Identicon";
import {
    ArrowLeftIcon,
    CheckIcon,
    CopyIcon,
    DownloadIcon,
    ShareIcon,
} from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";
import { useTheme } from "../../lib/state/themeContext";
import { addContact, findContact } from "../../lib/aztec/contacts";
import type { AztecNetwork } from "../../lib/aztec/networks";

/**
 * Build a payment URI that other wallets / QR scanners can parse.
 * Format mirrors the EIP-681 / "bitcoin:" convention so it's familiar.
 *
 *   aztec:<address>[?amount=<decimal>][&token=<contract>][&memo=<text>]
 */
function buildPaymentUri(address: string, amount: string, token: string, memo: string): string {
    const params = new URLSearchParams();
    if (amount.trim()) params.set("amount", amount.trim());
    if (token.trim()) params.set("token", token.trim());
    if (memo.trim()) params.set("memo", memo.trim());
    const q = params.toString();
    return q ? `aztec:${address}?${q}` : `aztec:${address}`;
}

export function Receive({ onBack }: { onBack: () => void }) {
    const { account, network } = useWallet();
    const { resolved } = useTheme();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [copied, setCopied] = useState(false);
    const [showOptions, setShowOptions] = useState(false);
    const [amount, setAmount] = useState("");
    const [memo, setMemo] = useState("");

    const addr = account?.address.toString() ?? "";

    const uri = useMemo(() => buildPaymentUri(addr, amount, "", memo), [addr, amount, memo]);

    useEffect(() => {
        if (!canvasRef.current || !addr) return;
        // Two-tone QR — dark background on dark theme reads beautifully even printed.
        QRCode.toCanvas(canvasRef.current, uri, {
            width: 232,
            margin: 1,
            errorCorrectionLevel: "M",
            color:
                resolved === "dark"
                    ? { dark: "#0a0a0d", light: "#ffffff" }
                    : { dark: "#1a1a22", light: "#ffffff" },
        });
    }, [uri, addr, resolved]);

    if (!account) return null;

    async function copy(text: string) {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    async function share() {
        if (typeof navigator.share === "function") {
            try {
                await navigator.share({
                    title: "My Aztec address",
                    text: amount
                        ? `Send ${amount} to my Aztec wallet:\n${addr}`
                        : `My Aztec address:\n${addr}`,
                });
                return;
            } catch {
                // User cancelled or share unavailable — fall through to clipboard.
            }
        }
        await copy(uri);
    }

    function downloadQr() {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const link = document.createElement("a");
        link.href = canvas.toDataURL("image/png");
        // Generic filename — an address prefix in the Downloads folder would tie
        // this machine to the address for anyone scanning the filesystem.
        link.download = "aztec-receive-qr.png";
        link.click();
    }

    return (
        <>
            <Header />
            <div className="content">
                <button
                    className="muted"
                    style={{
                        alignSelf: "flex-start",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                    }}
                    onClick={onBack}
                >
                    <ArrowLeftIcon size={14} /> Back
                </button>

                <div style={{ textAlign: "center" }}>
                    <Identicon address={addr} size={48} />
                    <div style={{ fontWeight: 600, fontSize: 16, marginTop: 8 }}>
                        Share your address
                    </div>
                    <div className="muted" style={{ marginTop: 2 }}>
                        Senders can pay you publicly or privately
                    </div>
                </div>

                <div style={{ display: "flex", justifyContent: "center" }}>
                    <div className="qr-frame">
                        <canvas ref={canvasRef} />
                    </div>
                </div>

                {/* Compact + always-visible address chip — taps reveal full address */}
                <div
                    className="address-mono"
                    onClick={() => copy(addr)}
                    style={{ cursor: "pointer", textAlign: "center" }}
                    title="Click to copy full address"
                >
                    {shortAddress(addr, 14, 12)}
                </div>

                <div className="share-grid">
                    <button className={`copy-btn ${copied ? "success" : ""}`} onClick={() => copy(addr)}>
                        {copied ? <CheckIcon /> : <CopyIcon />}
                        {copied ? "Copied" : "Copy"}
                    </button>
                    <button className="copy-btn" onClick={share}>
                        <ShareIcon />
                        Share
                    </button>
                    <button className="copy-btn" onClick={downloadQr}>
                        <DownloadIcon />
                        Save QR
                    </button>
                    <button
                        className="copy-btn"
                        onClick={() => setShowOptions((v) => !v)}
                        style={
                            showOptions
                                ? { borderColor: "var(--accent)", color: "var(--accent)" }
                                : undefined
                        }
                    >
                        {showOptions ? "Hide" : "Request amount"}
                    </button>
                </div>

                {showOptions && (
                    <div className="card fade-in" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div className="muted">Encode an amount or memo into the QR</div>
                        <div className="field">
                            <label>Amount (optional)</label>
                            <input
                                inputMode="decimal"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                placeholder="0.0"
                            />
                        </div>
                        <div className="field">
                            <label>Memo (optional, not on-chain)</label>
                            <input
                                value={memo}
                                onChange={(e) => setMemo(e.target.value)}
                                placeholder="Coffee, rent split, …"
                                maxLength={64}
                            />
                        </div>
                        <div className="hint">
                            Scanners that understand <code>aztec:</code> URIs will prefill these.
                            Plain wallets will just see your address.
                        </div>
                        <div className="hint" style={{ fontSize: 11 }}>
                            ⚠️ Anything encoded here travels with the QR/link: whoever you share it
                            with — and any app it passes through (messengers, email, screenshots) —
                            can read the amount and memo alongside your address.
                        </div>
                    </div>
                )}

                <ExpectingPrivateCard networkId={network.id} onViewBalance={onBack} />

                <div className="hint" style={{ textAlign: "center", fontSize: 12 }}>
                    Public payments always arrive automatically — no setup needed.
                </div>
            </div>
        </>
    );
}

/**
 * The one Aztec-specific step a retail user must understand: to SEE a private
 * payment, your wallet needs the sender's address. We frame it as "add who's
 * paying you" — no notes/tags/registration jargon — and reassure that a payment
 * already sent will still appear once they're added.
 */
function ExpectingPrivateCard({
    networkId,
    onViewBalance,
}: {
    networkId: AztecNetwork["id"];
    onViewBalance: () => void;
}) {
    const { wallet } = useWallet();
    const [open, setOpen] = useState(false);
    const [addr, setAddr] = useState("");
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [added, setAdded] = useState<string | null>(null);

    async function add() {
        setError(null);
        let canon: string;
        try {
            canon = AztecAddress.fromString(addr.trim()).toString();
        } catch {
            setError("That doesn't look like a valid Aztec address.");
            return;
        }
        setBusy(true);
        try {
            const existing = await findContact(networkId, canon);
            if (existing) {
                setAdded(existing.label);
                return;
            }
            const label = name.trim() || shortAddress(canon, 6, 4);
            await addContact(networkId, { address: canon, label, source: "manual" }, wallet);
            setAdded(label);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    if (added) {
        return (
            <div className="card card-accent fade-in">
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--success)", fontWeight: 500 }}>
                    <CheckIcon size={16} /> You'll now see private payments from {added}.
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                    If they already sent one, it'll appear on your balance shortly.
                </div>
                <button
                    className="btn btn-primary btn-block"
                    style={{ marginTop: 10 }}
                    onClick={onViewBalance}
                >
                    View my balance
                </button>
            </div>
        );
    }

    if (!open) {
        return (
            <button
                className="card card-accent"
                style={{ width: "100%", textAlign: "left", cursor: "pointer", display: "block" }}
                onClick={() => setOpen(true)}
            >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div>
                        <div style={{ fontWeight: 600 }}>🔒 Expecting a private payment?</div>
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                            Add who's sending so it shows up
                        </div>
                    </div>
                    <span className="muted" style={{ fontSize: 18 }}>
                        ›
                    </span>
                </div>
            </button>
        );
    }

    return (
        <div className="card card-accent fade-in" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontWeight: 600 }}>Expecting a private payment?</div>
            <div className="hint">
                Private payments stay hidden until your wallet knows who's sending. Add the
                sender's address and their payment appears automatically — even one they've
                already sent.
            </div>
            <div className="field">
                <label>Sender's address</label>
                <input
                    value={addr}
                    onChange={(e) => setAddr(e.target.value)}
                    placeholder="0x… (ask them to share it)"
                    style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
                    autoFocus
                />
            </div>
            <div className="field">
                <label>Name (optional)</label>
                <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Alice"
                    maxLength={32}
                />
            </div>
            {error && <div className="error">{error}</div>}
            <div style={{ display: "flex", gap: 8 }}>
                <button
                    className="btn btn-ghost btn-block"
                    onClick={() => {
                        setOpen(false);
                        setError(null);
                    }}
                >
                    Cancel
                </button>
                <button
                    className="btn btn-primary btn-block"
                    disabled={busy || !addr.trim()}
                    onClick={add}
                >
                    {busy ? "Adding…" : "Add sender"}
                </button>
            </div>
        </div>
    );
}
