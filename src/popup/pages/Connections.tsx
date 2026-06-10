import { useEffect, useState } from "react";
import { Header } from "../components/Header";
import { ArrowLeftIcon, LinkIcon, TrashIcon } from "../components/icons";
import { listConnections, removeConnection, type Connection } from "../../lib/state/connections";

function prettyOrigin(origin: string): string {
    return origin.replace(/^https?:\/\//, "");
}

function whenApproved(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
    });
}

/** Manage (and revoke) sites the user has connected to the wallet. */
export function Connections({ onBack }: { onBack: () => void }) {
    const [conns, setConns] = useState<Connection[] | null>(null);

    function load() {
        void listConnections().then(setConns);
    }
    useEffect(load, []);

    async function disconnect(origin: string) {
        await removeConnection(origin);
        load();
    }

    return (
        <>
            <Header />
            <div className="content">
                <button
                    className="muted"
                    style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 4 }}
                    onClick={onBack}
                >
                    <ArrowLeftIcon size={14} /> Back
                </button>

                <div style={{ fontWeight: 600, fontSize: 16 }}>Connected sites</div>
                <p className="hint">
                    Sites you've allowed to hand token launches to your wallet. They never see your
                    address or keys, and every deploy is still confirmed here. Disconnect anytime.
                </p>

                {conns === null && <div className="muted">Loading…</div>}

                {conns !== null && conns.length === 0 && (
                    <div className="card hint" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <LinkIcon size={16} />
                        No connected sites yet. When you connect one — like fizzwallet.com/launch —
                        it shows up here.
                    </div>
                )}

                {conns?.map((c) => (
                    <div
                        key={c.origin}
                        className="card"
                        style={{ display: "flex", alignItems: "center", gap: 10 }}
                    >
                        <span style={{ color: "var(--accent)" }}>
                            <LinkIcon size={18} />
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 500, wordBreak: "break-all" }}>
                                {prettyOrigin(c.origin)}
                            </div>
                            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                                Connected {whenApproved(c.approvedAt)}
                            </div>
                        </div>
                        <button
                            className="icon-btn"
                            onClick={() => disconnect(c.origin)}
                            title="Disconnect"
                            aria-label={`Disconnect ${prettyOrigin(c.origin)}`}
                        >
                            <TrashIcon />
                        </button>
                    </div>
                ))}
            </div>
        </>
    );
}
