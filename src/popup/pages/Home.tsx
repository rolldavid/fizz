import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Header, shortAddress } from "../components/Header";
import { Identicon } from "../components/Identicon";
import { DeployRecovery } from "../components/DeployRecovery";
import {
    CheckIcon,
    ConvertIcon,
    CopyIcon,
    HistoryIcon,
    KeyIcon,
    LinkIcon,
    LockIcon,
    MenuIcon,
    MoreIcon,
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
import { withPxeLock } from "../../lib/aztec/pxeLock";
import { onFeeJuiceLanded } from "../../lib/aztec/autoClaim";
import { listPendingBridges, markGasNoticeShown } from "../../lib/aztec/bridge";
import { describeError } from "../../lib/errors";

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
    | "history"
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
    const {
        wallet,
        account,
        accounts,
        switchAccount,
        addAccount,
        renameAccount,
        removeAccount,
        lock,
        network,
    } = useWallet();
    // STRICT rule: rows are tagged with the address they were fetched FOR, and
    // are only ever rendered while that address is still the active account.
    // Without this, a refresh started for account 1 could resolve after a
    // switch and paint account 1's balances under account 2's header
    // (observed live with SPRKL).
    const [rowState, setRowState] = useState<{
        forAddr: string;
        rows: RowState[];
        /** Confirmed bridge claims not yet swept by a transaction. */
        incoming: bigint;
    }>({ forAddr: "", rows: [], incoming: 0n });
    /** Unacknowledged "gas is on the way" claims (one-time notice). */
    const [gasNoticeIds, setGasNoticeIds] = useState<string[]>([]);
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
                return { ...prev, rows: update(prev.rows) };
            });
        const tokens = await loadTokens(network.id, addr);
        // Bridged gas that hasn't been swept by a transaction yet: shown
        // optimistically on the gas line, and announced once via the notice.
        const bridges = (await listPendingBridges(network.id)).filter((b) => b.recipient === addr);
        const incoming = bridges
            .filter((b) => b.status === "sent" || (b.status ?? "pending") === "pending")
            .reduce((sum, b) => sum + BigInt(b.claimAmount), 0n);
        const notice = bridges
            .filter((b) => (b.status ?? "pending") === "pending" && !b.noticeShownAt)
            .map((b) => b.id);
        if (activeAddrRef.current !== addr) return; // switched while loading
        setGasNoticeIds(notice);
        setRowState({
            forAddr: addr,
            rows: tokens.map((t) => ({ token: t, balance: ZERO_BALANCE, loading: true })),
            incoming,
        });
        // One PXE lock for the whole refresh: balance reads must not run while a
        // writer (boot sender-sync, a send/deploy) holds an IndexedDB
        // transaction open, or a read through that shared store throws
        // "transaction has finished" and the row shows a spurious error. With no
        // writer concurrent, the per-token reads are free to run in parallel.
        await withPxeLock(() =>
            Promise.all(
                tokens.map(async (token, i) => {
                    try {
                        const balance = await getTokenBalance(wallet, account.address, token);
                        apply((rows) =>
                            rows.map((r, j) => (j === i ? { token, balance, loading: false } : r)),
                        );
                    } catch (err) {
                        const error = describeError(err);
                        apply((rows) =>
                            rows.map((r, j) =>
                                j === i ? { token, balance: ZERO_BALANCE, loading: false, error } : r,
                            ),
                        );
                    }
                }),
            ),
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
    const incoming = switching ? 0n : rowState.incoming;
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
                    <HeaderMenu onNavigate={onNavigate} onLock={lock} />
                }
            />
            <div className="content">
                {/* Surfaces (and recovers) a deploy interrupted by the popup closing. */}
                <DeployRecovery onRecovered={refresh} />

                {/* Account card — a PROMINENT account-switcher pill on top.
                    Copying is the clipboard icon's job alone; the address text
                    is display-only (an accidental tap must not touch the
                    clipboard). */}
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
                        <div className="address-display" title={addrStr}>
                            {shortAddress(addrStr, 6, 4)}
                        </div>
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
                        onRename={renameAccount}
                        onRemove={removeAccount}
                        onClose={() => setShowAccounts(false)}
                    />
                )}

                {/* Gas goes STRAIGHT to the web bridge — the in-wallet Bridge
                    screen remains only as the hand-off window the web page
                    opens (recovery + auto-claim run in the background engine).
                    Sandbox keeps the in-wallet screen for its local mint. */}
                <FeeJuiceLine
                    row={feeJuiceRow}
                    incoming={incoming}
                    bridgeHref={network.id === "sandbox" ? undefined : "https://fizzwallet.com/bridge"}
                    onBridge={() => onNavigate("bridge")}
                    unit="AZTEC"
                    sponsored={sponsored === true}
                />

                {gasNoticeIds.length > 0 && !switching && (
                    <div className="modal-backdrop">
                        <div
                            className="card fade-in"
                            style={{ width: "100%", display: "flex", flexDirection: "column", gap: 10, textAlign: "center" }}
                        >
                            <img
                                src="/fizz.png"
                                alt=""
                                width={48}
                                height={48}
                                style={{ margin: "0 auto" }}
                            />
                            <div style={{ fontWeight: 600, fontSize: 17 }}>Gas is on the way</div>
                            <p className="hint" style={{ margin: 0 }}>
                                Your deposit is confirmed. The gas becomes usable in a few minutes.
                            </p>
                            <button
                                className="btn btn-primary btn-block"
                                onClick={async () => {
                                    const ids = gasNoticeIds;
                                    setGasNoticeIds([]);
                                    await markGasNoticeShown(ids);
                                }}
                            >
                                Got it
                            </button>
                        </div>
                    </div>
                )}

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
function HeaderMenu({
    onNavigate,
    onLock,
}: {
    onNavigate: (r: Route) => void;
    onLock: () => void;
}) {
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
                    {item("Transaction history", <HistoryIcon size={16} />, () => onNavigate("history"))}
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
    onRename,
    onRemove,
    onClose,
}: {
    accounts: import("../../lib/state/walletContext").AccountListEntry[];
    activeIndex: number;
    onPick: (index: number) => Promise<void>;
    onAdd: () => Promise<void>;
    onRename: (index: number, label: string) => Promise<void>;
    onRemove: (index: number) => Promise<void>;
    onClose: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Which row's ⋮ menu is open, if any. */
    const [menuFor, setMenuFor] = useState<number | null>(null);
    /** Which row is in rename mode, with its draft label. */
    const [renaming, setRenaming] = useState<number | null>(null);
    const [draftLabel, setDraftLabel] = useState("");

    async function run(fn: () => Promise<void>) {
        setError(null);
        setBusy(true);
        try {
            await fn();
        } catch (e) {
            setError(describeError(e));
        } finally {
            setBusy(false);
        }
    }

    function startRename(a: { index: number; label: string }) {
        setMenuFor(null);
        setRenaming(a.index);
        setDraftLabel(a.label);
    }

    async function saveRename(index: number) {
        await run(async () => {
            await onRename(index, draftLabel);
            setRenaming(null);
        });
    }

    return (
        <div className="modal-backdrop">
            <div
                className="card fade-in"
                style={{ width: "100%", display: "flex", flexDirection: "column", gap: 10 }}
            >
                <div style={{ fontWeight: 600, fontSize: 17 }}>Accounts</div>
                {accounts.map((a) => (
                    <div
                        key={a.index}
                        className="token-row"
                        style={{ width: "100%", padding: "12px 14px" }}
                    >
                        {renaming === a.index ? (
                            <div style={{ display: "flex", gap: 6, alignItems: "center", width: "100%" }}>
                                <input
                                    value={draftLabel}
                                    onChange={(e) => setDraftLabel(e.target.value)}
                                    maxLength={24}
                                    autoFocus
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") void saveRename(a.index);
                                        if (e.key === "Escape") setRenaming(null);
                                    }}
                                    style={{ flex: 1 }}
                                />
                                <button
                                    className="btn btn-primary"
                                    style={{ padding: "8px 12px", fontSize: 12 }}
                                    disabled={busy || !draftLabel.trim()}
                                    onClick={() => saveRename(a.index)}
                                >
                                    Save
                                </button>
                                <button
                                    className="btn btn-ghost"
                                    style={{ padding: "8px 10px", fontSize: 12 }}
                                    disabled={busy}
                                    onClick={() => setRenaming(null)}
                                >
                                    Cancel
                                </button>
                            </div>
                        ) : (
                            <>
                                <button
                                    className="token-meta"
                                    disabled={busy}
                                    style={{
                                        minWidth: 0,
                                        gap: 12,
                                        flex: 1,
                                        background: "none",
                                        border: "none",
                                        padding: 0,
                                        cursor: "pointer",
                                        textAlign: "left",
                                    }}
                                    onClick={() => run(() => onPick(a.index))}
                                >
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
                                            {shortAddress(a.address.toString(), 6, 4)}
                                        </div>
                                    </div>
                                </button>
                                <div className="header-menu">
                                    <button
                                        className="icon-btn"
                                        disabled={busy}
                                        onClick={() => setMenuFor(menuFor === a.index ? null : a.index)}
                                        title="Account actions"
                                        aria-label={`${a.label} actions`}
                                        aria-haspopup="menu"
                                        aria-expanded={menuFor === a.index}
                                    >
                                        <MoreIcon size={15} />
                                    </button>
                                    {menuFor === a.index && (
                                        <div className="menu-dropdown" role="menu">
                                            <button
                                                className="menu-item"
                                                role="menuitem"
                                                onClick={() => startRename(a)}
                                            >
                                                Rename account
                                            </button>
                                            <button
                                                className="menu-item"
                                                role="menuitem"
                                                disabled={a.index === activeIndex || accounts.length <= 1}
                                                title={
                                                    a.index === activeIndex
                                                        ? "Switch to another account first"
                                                        : accounts.length <= 1
                                                          ? "You can't remove your only account"
                                                          : undefined
                                                }
                                                onClick={() => {
                                                    setMenuFor(null);
                                                    // Hide-only: keys come from the recovery
                                                    // phrase and funds stay on-chain.
                                                    if (
                                                        !confirm(
                                                            `Remove ${a.label} from this wallet?\n\n` +
                                                                "Its keys come from your recovery phrase and any funds stay on-chain. " +
                                                                "“＋ New account” restores removed accounts first.",
                                                        )
                                                    )
                                                        return;
                                                    void run(() => onRemove(a.index));
                                                }}
                                            >
                                                Remove account
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
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

/** Fee juice (gas) — a single compact line: balance + a tap-through to the
 * bridge (external fizzwallet.com/bridge, or the in-wallet screen on sandbox). */
function FeeJuiceLine({
    row,
    incoming,
    bridgeHref,
    onBridge,
    unit,
    sponsored,
}: {
    row: RowState | undefined;
    /** Confirmed bridged gas not yet swept by a transaction (optimistic). */
    incoming: bigint;
    /** When set, the line is a plain link there (new tab). */
    bridgeHref?: string;
    onBridge: () => void;
    unit: string;
    sponsored: boolean;
}) {
    // Optimistic headline: confirmed-but-unswept bridge claims count straight
    // into the number — it's the user's gas either way (the first transaction
    // sweeps it in), so no transit marker.
    const balance = (row?.balance.public ?? 0n) + incoming;
    const title = sponsored ? "Fees are sponsored here. Bridging is optional" : "Get gas";
    if (bridgeHref) {
        return (
            <a className="fee-line" href={bridgeHref} target="_blank" rel="noreferrer" title={title}>
                <span className="muted">Gas</span>
                <span className="fee-line-amount">
                    {!row || row.loading ? (
                        <span className="spinner" />
                    ) : (
                        <>
                            {formatUnits(balance, FEE_JUICE_ENTRY.decimals)}{" "}
                            <span className="muted">{unit}</span>
                        </>
                    )}
                </span>
                <span className="fee-line-cta">Need gas? ↗</span>
            </a>
        );
    }
    return (
        <button className="fee-line" onClick={onBridge} title={title}>
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
            <span className="fee-line-cta">Need gas? →</span>
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
    const [menuOpen, setMenuOpen] = useState(false);
    const [addrCopied, setAddrCopied] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const value = tab === "private" ? balance.private : balance.public;
    const convertTo = tab === "private" ? "public" : "private";

    useEffect(() => {
        if (!menuOpen) return;
        const onDoc = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setMenuOpen(false);
        };
        document.addEventListener("mousedown", onDoc);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDoc);
            document.removeEventListener("keydown", onKey);
        };
    }, [menuOpen]);

    // Recipients must import a token by its contract address before they can
    // see it — so the address is one tap away in the row menu. Feedback is the
    // icon swap ALONE (check for a beat) — no text, no layout shift.
    async function copyTokenAddress() {
        await navigator.clipboard.writeText(token.address);
        setMenuOpen(false);
        setAddrCopied(true);
        setTimeout(() => setAddrCopied(false), 1500);
    }

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
            <div className="token-actions header-menu" ref={menuRef}>
                <button
                    className="icon-btn"
                    onClick={() => setMenuOpen((o) => !o)}
                    title={`${token.symbol} actions`}
                    aria-label={`${token.symbol} actions`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                >
                    {addrCopied ? <CheckIcon size={15} /> : <MoreIcon size={15} />}
                </button>
                {menuOpen && (
                    <div className="menu-dropdown" role="menu">
                        <button className="menu-item" role="menuitem" onClick={copyTokenAddress}>
                            <CopyIcon size={14} /> Copy address
                        </button>
                        <button
                            className="menu-item"
                            role="menuitem"
                            onClick={() => {
                                setMenuOpen(false);
                                onConvert();
                            }}
                        >
                            <ConvertIcon size={14} /> Swap to {convertTo}
                        </button>
                        <button
                            className="menu-item"
                            role="menuitem"
                            onClick={() => {
                                setMenuOpen(false);
                                onRemove();
                            }}
                        >
                            <TrashIcon size={14} /> Remove from list
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

