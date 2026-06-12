import { useEffect, useRef, useState } from "react";
import { Header, shortAddress } from "../components/Header";
import {
    ArrowLeftIcon,
    BookmarkIcon,
    ConvertIcon,
    DownloadIcon,
    LinkIcon,
    PlusIcon,
    ShareIcon,
} from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";
import { formatUnits } from "../../lib/aztec/balances";
import { loadTokens, type TokenEntry } from "../../lib/aztec/tokens";
import { listHistory, type TxHistoryEntry } from "../../lib/aztec/txHistory";
import { scanIncoming } from "../../lib/aztec/txHistoryScan";

/** Compact relative time ("just now", "2h ago", "3d ago"). */
function relativeTime(at: number): string {
    const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
    if (s < 45) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function prettyOrigin(origin: string): string {
    return origin.replace(/^https?:\/\//, "");
}

function iconFor(entry: TxHistoryEntry): React.ReactNode {
    switch (entry.kind) {
        case "transfer":
            return entry.direction === "in" ? <DownloadIcon size={16} /> : <ShareIcon size={16} />;
        case "shield":
        case "unshield":
            return <ConvertIcon size={16} />;
        case "mint":
            return <PlusIcon size={16} />;
        case "deploy":
            return <BookmarkIcon size={16} />;
        case "authorization":
            return <LinkIcon size={16} />;
    }
}

/** Local transaction history — per account, per network, on this device only. */
export function TransactionHistory({ onBack }: { onBack: () => void }) {
    const { wallet, account, network } = useWallet();
    const [entries, setEntries] = useState<TxHistoryEntry[]>([]);
    const [tokens, setTokens] = useState<TokenEntry[]>([]);
    const [loading, setLoading] = useState(true);

    // STRICT rule (mirrors Home): tag the load with the address it ran FOR, and
    // only apply results while that address is still active — a scan started for
    // account 1 must never paint under account 2.
    const activeAddrRef = useRef("");
    activeAddrRef.current = account?.address.toString() ?? "";

    useEffect(() => {
        if (!wallet || !account) return;
        const addr = account.address.toString();
        let cancelled = false;
        setLoading(true);
        (async () => {
            const toks = await loadTokens(network.id, addr);
            if (cancelled || activeAddrRef.current !== addr) return;
            setTokens(toks);
            // Discover incoming since the cursor (best-effort — never throws).
            await scanIncoming(wallet, network, addr);
            if (cancelled || activeAddrRef.current !== addr) return;
            const items = await listHistory(network.id, addr);
            if (cancelled || activeAddrRef.current !== addr) return;
            setEntries(items);
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [wallet, account, network.id]);

    const tokenFor = (address?: string): TokenEntry | undefined =>
        address ? tokens.find((t) => t.address.toLowerCase() === address.toLowerCase()) : undefined;

    function amountText(entry: TxHistoryEntry): string {
        if (entry.amount === undefined) return "";
        const token = tokenFor(entry.tokenAddress);
        const decimals = token?.decimals ?? 0;
        const sym = token?.symbol ?? (entry.tokenAddress ? shortAddress(entry.tokenAddress, 6, 4) : "");
        return `${formatUnits(BigInt(entry.amount), decimals)} ${sym}`.trim();
    }

    function titleFor(entry: TxHistoryEntry): string {
        switch (entry.kind) {
            case "transfer":
                return entry.direction === "in"
                    ? `Received ${amountText(entry)}`
                    : `Sent ${amountText(entry)}`;
            case "shield":
                return `Made private (${amountText(entry)})`;
            case "unshield":
                return `Made public (${amountText(entry)})`;
            case "mint":
                return `Minted ${amountText(entry)}`;
            case "deploy":
                return `Deployed ${entry.label ?? amountText(entry) ?? "token"}`;
            case "authorization":
                return entry.authAction === "revoked"
                    ? `Disconnected ${prettyOrigin(entry.origin ?? "")}`
                    : `Connected ${prettyOrigin(entry.origin ?? "")}`;
        }
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

                <div style={{ fontWeight: 600, fontSize: 16 }}>Transaction history</div>
                <p className="hint">
                    On this device only — never synced. All your sends, swaps, mints and deploys are
                    recorded. For incoming, only <strong>private</strong> transfers from people you
                    know (contacts / addresses you've sent to) appear, tracked from when you first
                    opened this screen — public transfers you receive aren't shown (the token
                    contract emits no event for them).
                </p>

                {loading && <div className="spinner" />}

                {!loading && entries.length === 0 && (
                    <div className="card hint" style={{ textAlign: "center" }}>
                        <div style={{ marginBottom: 8 }}>No activity yet.</div>
                        <div>
                            Your sends, swaps, mints and deploys show up here. Incoming covers
                            private transfers from known senders only (tracked from when history was
                            first opened); public transfers you receive won't appear.
                        </div>
                    </div>
                )}

                {entries.map((entry) => {
                    const linkable = entry.txHash && network.id === "alpha";
                    const counterparty =
                        entry.counterparty && entry.kind === "transfer"
                            ? shortAddress(entry.counterparty, 6, 4)
                            : null;
                    return (
                        <div key={entry.id} className="token-row">
                            <div className="token-meta" style={{ minWidth: 0, flex: 1, gap: 10 }}>
                                <span
                                    aria-hidden
                                    style={{
                                        display: "grid",
                                        placeItems: "center",
                                        width: 32,
                                        height: 32,
                                        borderRadius: "50%",
                                        background: "var(--surface-2, rgba(127,127,127,0.12))",
                                        color: "var(--accent)",
                                        flexShrink: 0,
                                    }}
                                >
                                    {iconFor(entry)}
                                </span>
                                <div style={{ minWidth: 0 }}>
                                    <div
                                        style={{
                                            fontWeight: 500,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                        }}
                                    >
                                        {titleFor(entry)}
                                    </div>
                                    <div
                                        className="muted"
                                        style={{
                                            fontSize: 11,
                                            marginTop: 2,
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 6,
                                            flexWrap: "wrap",
                                        }}
                                    >
                                        <span>{relativeTime(entry.at)}</span>
                                        {entry.privacy && entry.kind === "transfer" && (
                                            <span>· {entry.privacy === "private" ? "🔒 private" : "public"}</span>
                                        )}
                                        {counterparty && (
                                            <span style={{ fontFamily: "ui-monospace, monospace" }}>
                                                · {counterparty}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                            {linkable && (
                                <a
                                    className="muted"
                                    href={`https://aztecscan.xyz/tx-effects/${entry.txHash}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    title="View on Aztec Scan"
                                    aria-label="View on Aztec Scan"
                                    style={{ flexShrink: 0, fontSize: 14, textDecoration: "none" }}
                                >
                                    ↗
                                </a>
                            )}
                        </div>
                    );
                })}
            </div>
        </>
    );
}
