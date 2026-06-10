import { useState } from "react";
import { useWallet } from "../../lib/state/walletContext";
import { loadCustomNodeUrl, saveCustomNodeUrl } from "../../lib/aztec/networks";

export function Header({ right }: { right?: React.ReactNode }) {
    const { network, networks, setNetwork } = useWallet();
    const [showCustom, setShowCustom] = useState(false);

    async function onPick(value: string) {
        if (value === "custom") {
            // Re-connect immediately if a URL is already saved; otherwise ask.
            const existing = await loadCustomNodeUrl();
            if (existing) await setNetwork("custom");
            else setShowCustom(true);
            return;
        }
        await setNetwork(value as (typeof networks)[number]["id"]);
    }

    return (
        <div className="header">
            <div className="brand">
                <img src="/fizz_plain.svg" alt="Fizz" className="brand-logo-header" />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <select
                    value={network.id}
                    onChange={(e) => onPick(e.target.value)}
                    style={{
                        // backgroundColor (not the `background` shorthand) so the
                        // global select's custom chevron background-image survives.
                        backgroundColor: "var(--surface-2)",
                        color: "var(--text-dim)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-sm)",
                        padding: "5px 26px 5px 10px",
                        fontSize: 11,
                        width: "auto",
                    }}
                >
                    {networks.map((n) => (
                        <option key={n.id} value={n.id}>
                            {n.name}
                        </option>
                    ))}
                    <option value="custom">
                        {network.id === "custom" ? `Custom: ${network.nodeUrl}` : "Custom node…"}
                    </option>
                </select>
                {network.id === "custom" && (
                    <button
                        className="icon-btn"
                        onClick={() => setShowCustom(true)}
                        title="Edit custom node URL"
                        aria-label="Edit custom node URL"
                        style={{ fontSize: 11 }}
                    >
                        ✎
                    </button>
                )}
                {right}
            </div>
            {showCustom && (
                <CustomNodeDialog
                    onClose={() => setShowCustom(false)}
                    onSaved={async () => {
                        setShowCustom(false);
                        await setNetwork("custom");
                    }}
                />
            )}
        </div>
    );
}

function CustomNodeDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
    const [url, setUrl] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function save() {
        setError(null);
        setBusy(true);
        try {
            await saveCustomNodeUrl(url);
            onSaved();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    }

    return (
        <div className="modal-backdrop" style={{ zIndex: 50 }}>
            <div
                className="card fade-in"
                style={{ width: "100%", display: "flex", flexDirection: "column", gap: 10 }}
            >
                <div style={{ fontWeight: 600 }}>Custom Aztec node</div>
                <div className="hint">
                    Whatever node you use can see your address, IP, and query pattern. Pointing the
                    wallet at your own node removes that trust in a third party.
                </div>
                <div className="field">
                    <label>Node URL</label>
                    <input
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://my-node.example or http://localhost:8080"
                        style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
                    />
                </div>
                <div className="hint" style={{ fontSize: 11 }}>
                    Note: the extension's security policy only permits localhost and
                    *.aztec-labs.com endpoints in this build.
                </div>
                {error && <div className="error">{error}</div>}
                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-ghost btn-block" onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        className="btn btn-primary btn-block"
                        disabled={busy || !url.trim()}
                        onClick={save}
                    >
                        {busy ? "Connecting…" : "Save & connect"}
                    </button>
                </div>
            </div>
        </div>
    );
}

export function shortAddress(addr: string, head = 6, tail = 4): string {
    if (addr.length <= head + tail + 3) return addr;
    return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
