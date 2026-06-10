import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
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
    const { account } = useWallet();
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

                <div className="hint" style={{ textAlign: "center", fontSize: 12 }}>
                    Public payments arrive automatically. To SEE a private payment, add the sender
                    in <strong>Contacts</strong> first — your wallet only discovers private notes
                    from senders you've added.
                </div>
            </div>
        </>
    );
}

