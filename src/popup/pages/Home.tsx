import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
    MenuIcon,
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
import { onFeeJuiceLanded } from "../../lib/aztec/autoClaim";

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
    // STRICT rule: rows are tagged with the address they were fetched FOR, and
    // are only ever rendered while that address is still the active account.
    // Without this, a refresh started for account 1 could resolve after a
    // switch and paint account 1's balances under account 2's header
    // (observed live with SPRKL).
    const [rowState, setRowState] = useState<{ forAddr: string; rows: RowState[] }>({
        forAddr: "",
        rows: [],
    });
    const [tab, setTab] = useState<Tab>("private");
    const [showAccounts, setShowAccounts] = useState(false);
    const [copied, setCopied] = useState(false);
    const [sponsored, setSponsored] = useState<boolean | null>(null);

    // Live active address, readable from async closures so a stale refresh can
    // notice the account changed under it. Render-time assignment keeps it
    // exact even before effects run.
    const activeAddrRef = useRef("");
    activeAddrRef.current = account?.address.toString() ?? "";

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
        const addr = account.address.toString();
        // Every write below is double-gated: dropped if the active account
        // moved on (ref), and dropped if the row state belongs to another
        // address (functional check). An account only ever shows its own rows.
        const apply = (update: (rows: RowState[]) => RowState[]) =>
            setRowState((prev) => {
                if (activeAddrRef.current !== addr) return prev;
                if (prev.forAddr !== addr) return prev;
                return { forAddr: addr, rows: update(prev.rows) };
            });
        const tokens = await loadTokens(network.id, addr);
        if (activeAddrRef.current !== addr) return; // switched while loading
        setRowState({
            forAddr: addr,
            rows: tokens.map((t) => ({ token: t, balance: ZERO_BALANCE, loading: true })),
        });
        await Promise.all(
            tokens.map(async (token, i) => {
                try {
                    const balance = await getTokenBalance(wallet, account.address, token);
                    apply((rows) => rows.map((r, j) => (j === i ? { token, balance, loading: false } : r)));
                } catch (err) {
                    const error = err instanceof Error ? err.message : String(err);
                    apply((rows) =>
                        rows.map((r, j) =>
                            j === i ? { token, balance: ZERO_BALANCE, loading: false, error } : r,
                        ),
                    );
                }
            }),
        );
    }, [wallet, account, network.id]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    // The background claimer just turned a bridge claim into balance — show it.
    useEffect(() => onFeeJuiceLanded(() => void refresh()), [refresh]);

    // Render NOTHING from a previous account: a mismatch means the switch
    // happened and this account's refresh is still in flight.
    const currentAddr = account?.address.toString() ?? "";
    const switching = rowState.forAddr !== currentAddr;
    const rows = switching ? [] : rowState.rows;
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
            <Header right={<HeaderMenu onNavigate={onNavigate} onLock={lock} />} />
            <div className="content">
                {/* Surfaces (and recovers) a deploy interrupted by the popup closing. */}
                <DeployRecovery onRecovered={refresh} />

                {/* Account card — a PROMINENT account-switcher pill on top;
                    tapping the address (or the copy icon) copies it. */}
                <div className="card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Identicon address={addrStr} size={40} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <button
                            className="account-pill"
                            onClick={() => setShowAccounts(true)}
                            title="Switch account"
                            aria-label="Switch account"
                            aria-haspopup="dialog"
                        >
                            <span className="account-pill-label">{account.label}</span>
                            <span className="account-pill-chevron" aria-hidden>
                                ▾
                            </span>
                        </button>
                        <button
                            className="address-tap"
                            onClick={copyAddr}
                            title={copied ? "Copied" : "Copy address"}
                            aria-label="Copy address"
                        >
                            {shortAddress(addrStr, 10, 8)}
                            {copied && <span style={{ color: "var(--success)" }}> ✓ copied</span>}
                        </button>
                    </div>
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
                        // No manual refresh here: switching updates `account`,
                        // which re-creates `refresh` and re-fires its effect for
                        // the NEW address. Calling the captured (stale) refresh
                        // raced that and painted the old account's balances.
                        onPick={async (i) => {
                            await switchAccount(i);
                            setShowAccounts(false);
                        }}
                        onAdd={async () => {
                            await addAccount();
                            setShowAccounts(false);
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
                    {switching && (
                        <div className="card hint" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span className="spinner" /> Loading this account's balances…
                        </div>
                    )}

                    {!switching && tokenRows.length === 0 && (
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
                                await removeToken(network.id, addrStr, row.token.address);
                                refresh();
                            }}
                        />
                    ))}
                </div>

                {/* Sticky CTA — straight to the in-wallet Deploy screen. The
                    whole flow (form, proving, result) lives in the wallet. */}
                <button className="sticky-cta" onClick={() => onNavigate("deploy")}>
                    <span>Launch a token on Aztec</span>
                    <span className="link">Deploy →</span>
                </button>
            </div>
        </>
    );
}

/** Header hamburger → Contacts, Connected sites, Recovery phrase, Lock. */
function HeaderMenu({ onNavigate, onLock }: { onNavigate: (r: Route) => void; onLock: () => void }) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDoc);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDoc);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const item = (label: string, icon: React.ReactNode, fn: () => void) => (
        <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
                setOpen(false);
                fn();
            }}
        >
            {icon}
            {label}
        </button>
    );

    return (
        <div className="header-menu" ref={ref}>
            <button
                className="icon-btn"
                onClick={() => setOpen((o) => !o)}
                title="Menu"
                aria-label="Menu"
                aria-haspopup="menu"
                aria-expanded={open}
            >
                <MenuIcon />
            </button>
            {open && (
                <div className="menu-dropdown" role="menu">
                    {item("Contacts", <PeopleIcon size={16} />, () => onNavigate("contacts"))}
                    {item("Connected sites", <LinkIcon size={16} />, () => onNavigate("connections"))}
                    {item("Recovery phrase", <KeyIcon size={16} />, () => onNavigate("reveal"))}
                    {item("Lock", <LockIcon size={16} />, onLock)}
                </div>
            )}
        </div>
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
            title={sponsored ? "Fees are sponsored here. Bridging is optional" : "Get gas"}
        >
            <span className="muted">Gas</span>
            <span className="fee-line-amount">
                {/* No row yet = an account switch is in flight — never show a
                    placeholder 0 that could read as this account's balance. */}
                {!row || row.loading ? (
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
    const [addrCopied, setAddrCopied] = useState(false);
    const value = tab === "private" ? balance.private : balance.public;
    const convertTo = tab === "private" ? "public" : "private";

    // Recipients must import a token by its contract address before they can
    // see it — so the address needs to be one tap away, right on the row.
    async function copyTokenAddress() {
        await navigator.clipboard.writeText(token.address);
        setAddrCopied(true);
        setTimeout(() => setAddrCopied(false), 1500);
    }

    return (
        <div className="token-row">
            <button
                className="token-meta"
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
                onClick={copyTokenAddress}
                title={addrCopied ? "Copied" : `Copy ${token.symbol}'s contract address`}
                aria-label={`Copy ${token.symbol} contract address`}
            >
                <div className="token-glyph">{token.symbol.slice(0, 2).toUpperCase()}</div>
                <div>
                    <div style={{ fontWeight: 500 }}>
                        {token.symbol}
                        {addrCopied && (
                            <span style={{ color: "var(--success)", fontSize: 11 }}> ✓ address copied</span>
                        )}
                    </div>
                    <div className="muted">{token.name}</div>
                </div>
            </button>
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
                    onClick={copyTokenAddress}
                    title={addrCopied ? "Copied" : "Copy contract address"}
                    aria-label={`Copy ${token.symbol} contract address`}
                >
                    {addrCopied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
                </button>
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

