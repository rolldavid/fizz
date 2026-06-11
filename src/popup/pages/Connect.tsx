import { useEffect, useState } from "react";
import { Header } from "../components/Header";
import { CheckIcon, LinkIcon } from "../components/icons";
import { saveConnection, takePendingConnect } from "../../lib/state/connections";

type Phase = "loading" | "review" | "approved" | "none";

/** Strip the scheme so the user reads "fizzwallet.com", not "https://…". */
function prettyOrigin(origin: string): string {
    return origin.replace(/^https?:\/\//, "");
}

/**
 * Authorize a site to talk to the wallet (today: the fee-juice bridge).
 * Reached only via the
 * #connect deep link the background opens after a page sends "fizz:connect".
 * The user is already unlocked here (App.tsx gates locked → Unlock).
 *
 * Address-blind: approving stores ONLY the origin. The page never learns who
 * the user is, and the connection grants no spending authority — every action
 * is still confirmed in-wallet.
 */
export function Connect({ onDone }: { onDone: () => void }) {
    const [origin, setOrigin] = useState<string | null>(null);
    const [phase, setPhase] = useState<Phase>("loading");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        void takePendingConnect().then((req) => {
            if (req) {
                setOrigin(req.origin);
                setPhase("review");
            } else {
                setPhase("none");
            }
        });
    }, []);

    async function approve() {
        if (!origin) return;
        setBusy(true);
        await saveConnection(origin);
        setBusy(false);
        setPhase("approved");
    }

    // The connect window is a standalone popup window — closing it returns the
    // user to the page that asked. If we're somehow in the toolbar popup,
    // window.close() is a no-op, so fall back to navigating home.
    function close() {
        window.close();
        onDone();
    }

    return (
        <>
            <Header />
            <div className="content">
                {phase === "loading" && <div className="muted">Loading…</div>}

                {phase === "none" && (
                    <>
                        <div style={{ fontWeight: 600, fontSize: 16 }}>No pending request</div>
                        <p className="hint">
                            There's no connection waiting for approval. Start the connection from the
                            site you want to link (for example fizzwallet.com/bridge).
                        </p>
                        <button className="btn btn-primary btn-block" onClick={close}>
                            Close
                        </button>
                    </>
                )}

                {phase === "review" && origin && (
                    <>
                        <div style={{ textAlign: "center", marginTop: 16 }}>
                            <div
                                style={{
                                    width: 52,
                                    height: 52,
                                    borderRadius: "50%",
                                    background: "var(--surface-2)",
                                    color: "var(--accent)",
                                    display: "grid",
                                    placeItems: "center",
                                    margin: "0 auto 12px",
                                }}
                            >
                                <LinkIcon size={24} />
                            </div>
                            <div style={{ fontWeight: 600, fontSize: 16 }}>Connect this site?</div>
                            <div
                                className="address-mono"
                                style={{ marginTop: 6, fontSize: 14, wordBreak: "break-all" }}
                            >
                                {prettyOrigin(origin)}
                            </div>
                        </div>

                        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <Bullet>It can ask your wallet to open a fee-juice bridge.</Bullet>
                            <Bullet>You review and confirm every action here, in the wallet.</Bullet>
                            <Bullet>
                                It never sees your balances or keys and can't move funds. (A fee-juice
                                bridge shares your address with the page — you approve that separately.)
                            </Bullet>
                        </div>

                        <button
                            className="btn btn-primary btn-block"
                            disabled={busy}
                            onClick={approve}
                        >
                            {busy ? "Connecting…" : "Connect"}
                        </button>
                        <button className="btn btn-ghost btn-block" onClick={close}>
                            Cancel
                        </button>
                    </>
                )}

                {phase === "approved" && origin && (
                    <>
                        <div style={{ textAlign: "center", marginTop: 24 }}>
                            <div
                                style={{
                                    width: 56,
                                    height: 56,
                                    borderRadius: "50%",
                                    background: "rgba(74, 222, 128, 0.15)",
                                    color: "var(--success)",
                                    display: "grid",
                                    placeItems: "center",
                                    margin: "0 auto 12px",
                                }}
                            >
                                <CheckIcon size={28} />
                            </div>
                            <div style={{ fontWeight: 600, fontSize: 18 }}>Connected</div>
                            <div className="muted" style={{ marginTop: 4 }}>
                                {prettyOrigin(origin)} can now talk to your wallet.
                            </div>
                        </div>
                        <div className="hint">
                            Return to the site to continue. You can disconnect anytime from{" "}
                            <strong>Connected sites</strong> in the wallet.
                        </div>
                        <button className="btn btn-primary btn-block" onClick={close}>
                            Done
                        </button>
                    </>
                )}
            </div>
        </>
    );
}

function Bullet({ children }: { children: React.ReactNode }) {
    return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span style={{ color: "var(--accent)", marginTop: 2 }}>
                <CheckIcon size={14} />
            </span>
            <span style={{ fontSize: 13, lineHeight: 1.45 }}>{children}</span>
        </div>
    );
}
