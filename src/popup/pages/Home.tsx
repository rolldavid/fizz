import { useCallback, useEffect, useMemo, useState } from "react";
import { Header, shortAddress } from "../components/Header";
import { Identicon } from "../components/Identicon";
import { DeployRecovery } from "../components/DeployRecovery";
import {
    CheckIcon,
    ConvertIcon,
    CopyIcon,
    KeyIcon,
    LinkIcon,
    LockIcon,
    PeopleIcon,
    TrashIcon,
} from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";
import {
    formatUnits,
    getTokenBalance,
    ZERO_BALANCE,
    type TokenBalance,
} from "../../lib/aztec/balances";
import { FEE_JUICE_ENTRY, loadTokens, removeToken, type TokenEntry } from "../../lib/aztec/tokens";
import { isSponsoredFPCAvailable } from "../../lib/aztec/fee";

type Route =
    | "home"
    | "send"
    | "receive"
    | "bridge"
    | "deploy"
    | "mint"
    | "create"
    | "import"
    | "contacts"
    | "connections"
    | "reveal";
type Tab = "private" | "public";

type RowState = {
    token: TokenEntry;
    balance: TokenBalance;
    error?: string;
    loading: boolean;
};

export function Home({
    onNavigate,
    onConvert,
}: {
    onNavigate: (r: Route) => void;
    onConvert: (target: import("./Convert").ConvertTarget) => void;
}) {
    const { wallet, account, accounts, switchAccount, addAccount, lock, network } = useWallet();
    const [rows, setRows] = useState<RowState[]>([]);
    const [tab, setTab] = useState<Tab>("private");
    const [showAccounts, setShowAccounts] = useState(false);
    const [copied, setCopied] = useState(false);
    const [sponsored, setSponsored] = useState<boolean | null>(null);

    useEffect(() => {
        if (!wallet) return;
        let cancelled = false;
        isSponsoredFPCAvailable(wallet).then(
            (ok) => !cancelled && setSponsored(ok),
            () => !cancelled && setSponsored(null),
        );
        return () => {
            cancelled = true;
        };
    }, [wallet]);

    const refresh = useCallback(async () => {
        if (!wallet || !account) return;
        const tokens = await loadTokens(network.id);
        setRows(tokens.map((t) => ({ token: t, balance: ZERO_BALANCE, loading: true })));
        await Promise.all(
            tokens.map(async (token, i) => {
                try {
                    const balance = await getTokenBalance(wallet, account.address, token);
                    setRows((prev) => {
                        const next = [...prev];
                        next[i] = { token, balance, loading: false };
                        return next;
                    });
                } catch (err) {
                    setRows((prev) => {
                        const next = [...prev];
                        next[i] = {
                            token,
                            balance: ZERO_BALANCE,
                            loading: false,
                            error: err instanceof Error ? err.message : String(err),
                        };
                        return next;
                    });
                }
            }),
        );
    }, [wallet, account, network.id]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const feeJuiceRow = useMemo(() => rows.find((r) => r.token.kind === "fee_juice"), [rows]);
    const tokenRows = useMemo(() => rows.filter((r) => r.token.kind !== "fee_juice"), [rows]);

    if (!account) return null;
    const addrStr = account.address.toString();

    async function copyAddr() {
        await navigator.clipboard.writeText(addrStr);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    return (
        <>
            <Header
                right={
                    <>
                        <button
                            className="icon-btn"
                            onClick={() => onNavigate("contacts")}
                            title="Contacts"
                            aria-label="Contacts"
                        >
                            <PeopleIcon />
                        </button>
                        <button
                            className="icon-btn"
                            onClick={() => onNavigate("connections")}
                            title="Connected sites"
                            aria-label="Connected sites"
                        >
                            <LinkIcon />
                        </button>
                        <button
                            className="icon-btn"
                            onClick={() => onNavigate("reveal")}
                            title="Recovery phrase"
                            aria-label="Recovery phrase"
                        >
                            <KeyIcon />
                        </button>
                        <button
                            className="icon-btn"
                            onClick={lock}
                            title="Lock"
                            aria-label="Lock wallet"
                        >
                            <LockIcon />
                        </button>
                    </>
                }
            />
            <div className="content">
                {/* Surfaces (and recovers) a deploy interrupted by the popup closing. */}
                <DeployRecovery onRecovered={refresh} />

                {/* Account card — identicon + short address + tap to copy / share */}
                <div className="card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Identicon address={addrStr} size={40} />
                    <button
                        style={{
                            flex: 1,
                            minWidth: 0,
                            textAlign: "left",
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                        }}
                        onClick={() => setShowAccounts(true)}
                        title="Switch account"
                        aria-label="Switch account"
                    >
                        <div
                            className="muted"
                            style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}
                        >
                            {account.label}{" "}
                            <span style={{ fontSize: 16, lineHeight: 1, color: "var(--text-dim)" }}>▾</span>
                        </div>
                        <div
                            style={{
                                fontFamily: "ui-monospace, monospace",
                                fontSize: 13,
                                marginTop: 2,
                                color: "var(--text)",
                            }}
                            title={addrStr}
                        >
                            {shortAddress(addrStr, 10, 8)}
                        </div>
                    </button>
                    <button
                        className="icon-btn"
                        onClick={copyAddr}
                        title={copied ? "Copied" : "Copy"}
                        aria-label="Copy address"
                    >
                        {copied ? <CheckIcon /> : <CopyIcon />}
                    </button>
                </div>

                {showAccounts && (
                    <AccountSwitcher
                        accounts={accounts}
                        activeIndex={account.index}
                        onPick={async (i) => {
                            await switchAccount(i);
                            setShowAccounts(false);
                            refresh();
                        }}
                        onAdd={async () => {
                            await addAccount();
                            setShowAccounts(false);
                            refresh();
                        }}
                        onClose={() => setShowAccounts(false)}
                    />
                )}

                <FeeJuiceLine
                    row={feeJuiceRow}
                    onBridge={() => onNavigate("bridge")}
                    unit="AZTEC"
                    sponsored={sponsored === true}
                />

                <div className="nav">
                    <button className="btn btn-primary btn-block" onClick={() => onNavigate("send")}>
                        Send
                    </button>
                    <button className="btn btn-ghost btn-block" onClick={() => onNavigate("receive")}>
                        Receive
                    </button>
                </div>

                {/* Text-tab headings over the list (not pill buttons — those
                    clashed with the big Send/Receive pills). */}
                <div className="text-tabs">
                    <button
                        className={`text-tab ${tab === "private" ? "active" : ""}`}
                        onClick={() => setTab("private")}
                    >
                        Private Tokens
                    </button>
                    <button
                        className={`text-tab ${tab === "public" ? "active" : ""}`}
                        onClick={() => setTab("public")}
                    >
                        Public Tokens
                    </button>
                    <button
                        className="btn btn-ghost"
                        style={{ marginLeft: "auto", padding: "4px 10px", fontSize: 11 }}
                        onClick={() => onNavigate("import")}
                    >
                        + Import
                    </button>
                </div>

                <div>

                    {tokenRows.length === 0 && (
                        <div className="card hint">
                            No tokens yet. Import one by contract address to see {tab} balances.
                        </div>
                    )}

                    {tokenRows.map((row) => (
                        <TokenRow
                            key={row.token.address}
                            row={row}
                            tab={tab}
                            // Convert to the OPPOSITE of the list this row is shown in:
                            // a private-list row makes the balance public (unshield).
                            onConvert={() =>
                                onConvert({
                                    tokenAddress: row.token.address,
                                    direction: tab === "private" ? "unshield" : "shield",
                                })
                            }
                            onRemove={async () => {
                                await removeToken(network.id, row.token.address);
                                refresh();
                            }}
                        />
                    ))}
                </div>

                {/* Sticky CTA — straight to the web launcher (no intermediate
                    in-wallet screen). It hands the deploy back here to confirm. */}
                <a
                    className="sticky-cta"
                    href="https://fizzwallet.com/launch"
                    target="_blank"
                    rel="noreferrer"
                >
                    <span>Launch a token on Aztec</span>
                    <span className="link">Open ↗</span>
                </a>
            </div>
        </>
    );
}

function AccountSwitcher({
    accounts,
    activeIndex,
    onPick,
    onAdd,
    onClose,
}: {
    accounts: import("../../lib/state/walletContext").AccountListEntry[];
    activeIndex: number;
    onPick: (index: number) => Promise<void>;
    onAdd: () => Promise<void>;
    onClose: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function run(fn: () => Promise<void>) {
        setError(null);
        setBusy(true);
        try {
            await fn();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="modal-backdrop">
            <div
                className="card fade-in"
                style={{ width: "100%", display: "flex", flexDirection: "column", gap: 10 }}
            >
                <div style={{ fontWeight: 600, fontSize: 17 }}>Accounts</div>
                {accounts.map((a) => (
                    <button
                        key={a.index}
                        className="token-row"
                        disabled={busy}
                        style={{ cursor: "pointer", textAlign: "left", width: "100%", padding: "12px 14px" }}
                        onClick={() => run(() => onPick(a.index))}
                    >
                        <div className="token-meta" style={{ minWidth: 0, gap: 12 }}>
                            <Identicon address={a.address.toString()} size={36} />
                            <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: 15 }}>
                                    {a.label}
                                    {a.index === activeIndex && (
                                        <span style={{ color: "var(--success)" }}> ✓</span>
                                    )}
                                </div>
                                <div
                                    className="muted"
                                    style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
                                >
                                    {shortAddress(a.address.toString(), 8, 6)}
                                </div>
                            </div>
                        </div>
                    </button>
                ))}
                {error && <div className="error">{error}</div>}
                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-ghost btn-block" disabled={busy} onClick={onClose}>
                        Close
                    </button>
                    <button
                        className="btn btn-primary btn-block"
                        disabled={busy}
                        onClick={() => run(onAdd)}
                    >
                        {busy ? "…" : "＋ New account"}
                    </button>
                </div>
            </div>
        </div>
    );
}

/** Fee juice (gas) — a single compact line: balance + a tap-through to bridge. */
function FeeJuiceLine({
    row,
    onBridge,
    unit,
    sponsored,
}: {
    row: RowState | undefined;
    onBridge: () => void;
    unit: string;
    sponsored: boolean;
}) {
    const balance = row?.balance.public ?? 0n;
    return (
        <button
            className="fee-line"
            onClick={onBridge}
            title={sponsored ? "Fees are sponsored here — bridging is optional" : "Get gas"}
        >
            <span className="muted">Gas</span>
            <span className="fee-line-amount">
                {row?.loading ? (
                    <span className="spinner" />
                ) : (
                    <>
                        {formatUnits(balance, FEE_JUICE_ENTRY.decimals)}{" "}
                        <span className="muted">{unit}</span>
                    </>
                )}
            </span>
            <span className="fee-line-cta">{sponsored ? "Sponsored · bridge →" : "Need gas? →"}</span>
        </button>
    );
}

function TokenRow({
    row,
    tab,
    onConvert,
    onRemove,
}: {
    row: RowState;
    tab: Tab;
    onConvert: () => void;
    onRemove: () => void;
}) {
    const { token, balance } = row;
    const value = tab === "private" ? balance.private : balance.public;
    const convertTo = tab === "private" ? "public" : "private";
    return (
        <div className="token-row">
            <div className="token-meta">
                <div className="token-glyph">{token.symbol.slice(0, 2).toUpperCase()}</div>
                <div>
                    <div style={{ fontWeight: 500 }}>{token.symbol}</div>
                    <div className="muted">{token.name}</div>
                </div>
            </div>
            <div className="balance">
                {row.loading ? (
                    <span className="spinner" />
                ) : row.error ? (
                    // Never render a failed read as "0" — that's indistinguishable
                    // from genuinely empty and hides the problem.
                    <>
                        <div className="balance-amount" title={row.error}>
                            —
                        </div>
                        <div className="balance-sub" style={{ color: "var(--danger)" }}>
                            error
                        </div>
                    </>
                ) : (
                    <>
                        <div className="balance-amount">{formatUnits(value, token.decimals)}</div>
                        <div className="balance-sub">
                            {tab === "private" ? "private" : "public"}
                        </div>
                    </>
                )}
            </div>
            <div className="token-actions">
                <button
                    className="icon-btn"
                    onClick={onConvert}
                    title={`Convert to ${convertTo}`}
                    aria-label={`Convert ${token.symbol} to ${convertTo}`}
                >
                    <ConvertIcon size={15} />
                </button>
                <button
                    className="muted token-remove"
                    onClick={onRemove}
                    title="Remove from list"
                    aria-label={`Remove ${token.symbol}`}
                >
                    <TrashIcon size={13} />
                </button>
            </div>
        </div>
    );
}

