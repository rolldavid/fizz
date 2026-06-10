import { useState } from "react";
import { Header, shortAddress } from "../components/Header";
import { ArrowLeftIcon, CheckIcon, CopyIcon } from "../components/icons";
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

                {/* Step 1 — your address + copy */}
                <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div className="step-head">
                        <span className="step-num">1</span> Share your address
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div
                            className="address-mono"
                            onClick={() => copy(addr)}
                            style={{ cursor: "pointer", wordBreak: "break-all", flex: 1, minWidth: 0 }}
                            title="Click to copy full address"
                        >
                            {shortAddress(addr, 14, 12)}
                        </div>
                        <button
                            className={`copy-btn ${copied ? "success" : ""}`}
                            onClick={() => copy(addr)}
                            style={{ flexShrink: 0 }}
                            aria-label={copied ? "Copied" : "Copy address"}
                        >
                            {copied ? <CheckIcon /> : <CopyIcon />}
                            {copied ? "Copied" : "Copy"}
                        </button>
                    </div>
                </div>

                {/* Step 2 — register the sender so private notes are discovered */}
                <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div className="step-head">
                        <span className="step-num">2</span> Add contact
                    </div>
                    <div className="hint" style={{ margin: 0 }}>
                        Add the sender as a contact so your wallet knows where to look for incoming
                        private payments.
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
                        Paste the token's contract address so it appears in your token list.
                    </div>
                    <button className="btn btn-ghost btn-block" onClick={() => onNavigate("import")}>
                        Import a token →
                    </button>
                </div>
            </div>
        </>
    );
}
