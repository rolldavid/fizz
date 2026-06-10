import { useState } from "react";
import { Header, shortAddress } from "../components/Header";
import { ArrowLeftIcon, CheckIcon, CopyIcon, ShareIcon } from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";

export function Receive({
    onNavigate,
}: {
    onNavigate: (r: "home" | "contacts" | "import") => void;
}) {
    const { account } = useWallet();
    const [copied, setCopied] = useState(false);

    const addr = account?.address.toString() ?? "";

    if (!account) return null;

    async function copy(text: string) {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    async function share() {
        if (typeof navigator.share === "function") {
            try {
                await navigator.share({ title: "My Aztec address", text: `My Aztec address:\n${addr}` });
                return;
            } catch {
                // User cancelled or share unavailable — fall through to clipboard.
            }
        }
        await copy(addr);
    }

    return (
        <>
            <Header />
            <div className="content">
                <button
                    className="muted"
                    style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 4 }}
                    onClick={() => onNavigate("home")}
                >
                    <ArrowLeftIcon size={14} /> Back
                </button>

                <div style={{ fontWeight: 600, fontSize: 16 }}>Receive</div>

                {/* Step 1 — share your address */}
                <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
                    <div className="step-head">
                        <span className="step-num">1</span> Share your address
                    </div>
                    <div
                        className="address-mono"
                        onClick={() => copy(addr)}
                        style={{ cursor: "pointer", textAlign: "center", wordBreak: "break-all" }}
                        title="Click to copy full address"
                    >
                        {shortAddress(addr, 14, 12)}
                    </div>
                    <div className="share-grid" style={{ width: "100%" }}>
                        <button className={`copy-btn ${copied ? "success" : ""}`} onClick={() => copy(addr)}>
                            {copied ? <CheckIcon /> : <CopyIcon />}
                            {copied ? "Copied" : "Copy"}
                        </button>
                        <button className="copy-btn" onClick={share}>
                            <ShareIcon />
                            Share
                        </button>
                    </div>
                </div>

                {/* Step 2 — register the sender so private notes are discovered */}
                <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div className="step-head">
                        <span className="step-num">2</span> Add who's paying you
                    </div>
                    <div className="hint" style={{ margin: 0 }}>
                        A <strong>private</strong> payment only shows up once you've added the sender
                        as a contact — your wallet discovers private notes from known senders only.
                        (Public payments arrive automatically.)
                    </div>
                    <button className="btn btn-ghost btn-block" onClick={() => onNavigate("contacts")}>
                        Add a contact →
                    </button>
                </div>

                {/* Step 3 — import the token so its balance appears */}
                <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div className="step-head">
                        <span className="step-num">3</span> Add the token
                    </div>
                    <div className="hint" style={{ margin: 0 }}>
                        Paste the token's contract address so Fizz tracks it — its name, symbol and
                        decimals are read from the contract automatically.
                    </div>
                    <button className="btn btn-ghost btn-block" onClick={() => onNavigate("import")}>
                        Import a token →
                    </button>
                </div>
            </div>
        </>
    );
}

