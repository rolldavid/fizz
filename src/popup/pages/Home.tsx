import { useCallback, useEffect, useMemo, useState } from "react";
import { Header, shortAddress } from "../components/Header";
import { Identicon } from "../components/Identicon";
import { CheckIcon, CopyIcon, KeyIcon, LockIcon, PeopleIcon, QrIcon } from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";
import { KEYS, storage } from "../../lib/storage";
import {
    formatUnits,
    getTokenBalance,
    ZERO_BALANCE,
    type TokenBalance,
} from "../../lib/aztec/balances";
import {
    FEE_JUICE_ENTRY,
    addToken,
    loadTokens,
    removeToken,
    type TokenEntry,
} from "../../lib/aztec/tokens";
import { isSponsoredFPCAvailable } from "../../lib/aztec/fee";

type Route = "home" | "send" | "receive" | "bridge" | "deploy" | "mint" | "contacts" | "reveal";
type Tab = "private" | "public";

type RowState = {
    token: TokenEntry;
    balance: TokenBalance;
    error?: string;
    loading: boolean;
};

export function Home({ onNavigate }: { onNavigate: (r: Route) => void }) {
    const { wallet, account, accounts, switchAccount, addAccount, lock, network } = useWallet();
    const [rows, setRows] = useState<RowState[]>([]);
    const [tab, setTab] = useState<Tab>("private");
    const [showAdd, setShowAdd] = useState(false);
    const [showAccounts, setShowAccounts] = useState(false);
    const [copied, setCopied] = useState(false);
    const [showIntro, setShowIntro] = useState(false);
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

    useEffect(() => {
        storage.get<boolean>(KEYS.homeIntroSeen).then((seen) => setShowIntro(!seen));
    }, []);

    function dismissIntro() {
        setShowIntro(false);
        void storage.set(KEYS.homeIntroSeen, true);
    }

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
                {showIntro && (
                    <div
                        className="card card-accent fade-in"
                        style={{ display: "flex", flexDirection: "column", gap: 8 }}
                    >
                        <div style={{ fontWeight: 600 }}>👋 Two kinds of balance</div>
                        <div className="hint">
                            <b>Private</b> is hidden on-chain. <b>Public</b> is visible, like a
                            normal token. You can send either way, and use <b>Convert</b> (in Send)
                            to move between them anytime.
                        </div>
                        <button
                            className="btn btn-ghost"
                            style={{ alignSelf: "flex-end", padding: "6px 14px", fontSize: 12 }}
                            onClick={dismissIntro}
                        >
                            Got it
                        </button>
                    </div>
                )}

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
                        <div className="muted" style={{ fontSize: 11 }}>
                            {account.label} ▾
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
                        {!account.isDeployed && (
                            <div className="muted" style={{ marginTop: 4, color: "var(--accent)" }}>
                                Activates on your first transaction
                            </div>
                        )}
                    </button>
                    <button
                        className="icon-btn"
                        onClick={copyAddr}
                        title={copied ? "Copied" : "Copy"}
                        aria-label="Copy address"
                    >
                        {copied ? <CheckIcon /> : <CopyIcon />}
                    </button>
                    <button
                        className="icon-btn"
                        onClick={() => onNavigate("receive")}
                        title="Show QR"
                        aria-label="Receive"
                    >
                        <QrIcon />
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

                <FeeJuiceCard
                    row={feeJuiceRow}
                    onBridge={() => onNavigate("bridge")}
                    faucetUrl={network.faucetUrl}
                    address={addrStr}
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

                <div className="tabs">
                    <button
                        className={`tab private ${tab === "private" ? "active" : ""}`}
                        onClick={() => setTab("private")}
                    >
                        <span className="tab-dot" /> Private
                    </button>
                    <button
                        className={`tab ${tab === "public" ? "active" : ""}`}
                        onClick={() => setTab("public")}
                    >
                        <span className="tab-dot" /> Public
                    </button>
                </div>

                {tab === "private" && (
                    <div
                        className="hint"
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 8,
                        }}
                    >
                        <span>Expecting a private payment but don't see it?</span>
                        <button
                            onClick={() => onNavigate("receive")}
                            style={{
                                color: "var(--accent)",
                                fontWeight: 600,
                                whiteSpace: "nowrap",
                                cursor: "pointer",
                                background: "none",
                                border: "none",
                                padding: 0,
                            }}
                        >
                            Add the sender →
                        </button>
                    </div>
                )}

                <div>
                    <div
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: 8,
                        }}
                    >
                        <div className="muted">
                            {tab === "private" ? "Private balances" : "Public balances"}
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                            <button
                                className="btn btn-ghost"
                                style={{ padding: "4px 10px", fontSize: 11 }}
                                onClick={() => onNavigate("mint")}
                            >
                                Mint
                            </button>
                            <button
                                className="btn btn-ghost"
                                style={{ padding: "4px 10px", fontSize: 11 }}
                                onClick={() => onNavigate("deploy")}
                            >
                                + Deploy
                            </button>
                            <button
                                className="btn btn-ghost"
                                style={{ padding: "4px 10px", fontSize: 11 }}
                                onClick={() => setShowAdd(true)}
                            >
                                + Import
                            </button>
                        </div>
                    </div>

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
                            onRemove={async () => {
                                await removeToken(network.id, row.token.address);
                                refresh();
                            }}
                        />
                    ))}
                </div>

                {showAdd && (
                    <AddTokenDialog
                        networkId={network.id}
                        onClose={() => setShowAdd(false)}
                        onAdded={refresh}
                    />
                )}
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
                style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}
            >
                <div style={{ fontWeight: 600 }}>Accounts</div>
                <div className="hint" style={{ fontSize: 11 }}>
                    Separate accounts keep activities unlinkable — e.g. one address for public
                    bridging/funding, another for private spending. All derive from your one
                    recovery phrase.
                </div>
                {accounts.map((a) => (
                    <button
                        key={a.index}
                        className="token-row"
                        disabled={busy}
                        style={{ cursor: "pointer", textAlign: "left", width: "100%" }}
                        onClick={() => run(() => onPick(a.index))}
                    >
                        <div className="token-meta" style={{ minWidth: 0 }}>
                            <Identicon address={a.address.toString()} size={28} />
                            <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 500 }}>
                                    {a.label}
                                    {a.index === activeIndex && (
                                        <span style={{ color: "var(--success)" }}> ✓</span>
                                    )}
                                </div>
                                <div
                                    className="muted"
                                    style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}
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

function FeeJuiceCard({
    row,
    onBridge,
    faucetUrl,
    address,
    sponsored,
}: {
    row: RowState | undefined;
    onBridge: () => void;
    faucetUrl?: string;
    address: string;
    sponsored: boolean;
}) {
    const balance = row?.balance.public ?? 0n;
    const needsFunding = balance === 0n && !row?.loading && !sponsored;

    function openFaucet() {
        if (!faucetUrl) return;
        // Deliberately NOT pre-filling the address into the URL: query strings
        // land in the faucet operator's server logs (plus referrers/history),
        // handing them a clean IP↔address pair. The user pastes it themselves.
        void address;
        window.open(faucetUrl, "_blank", "noopener,noreferrer");
    }

    return (
        <div className="card card-accent">
            <div
                style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 6,
                }}
            >
                <div className="muted">Fee juice (gas)</div>
                <div style={{ display: "flex", gap: 6 }}>
                    {faucetUrl && (
                        <button
                            className="btn btn-ghost"
                            style={{ padding: "4px 10px", fontSize: 11 }}
                            onClick={openFaucet}
                            title="Open faucet in a new tab"
                        >
                            Faucet ↗
                        </button>
                    )}
                    <button
                        className="btn btn-ghost"
                        style={{ padding: "4px 10px", fontSize: 11 }}
                        onClick={onBridge}
                    >
                        Bridge ETH →
                    </button>
                </div>
            </div>
            <div style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {row?.loading ? (
                    <span className="spinner" />
                ) : (
                    formatUnits(balance, FEE_JUICE_ENTRY.decimals)
                )}{" "}
                <span className="muted" style={{ fontSize: 12 }}>
                    JUICE
                </span>
            </div>
            {needsFunding && faucetUrl && (
                <div className="hint" style={{ marginTop: 6 }}>
                    No fee juice yet. Click <b>Faucet ↗</b>, then copy your address from the card
                    above and paste it there. Usually arrives in a few minutes.
                </div>
            )}
            {needsFunding && !faucetUrl && (
                <div className="hint" style={{ marginTop: 6 }}>
                    Bridge ETH from L1 to mint fee juice, or switch to a network with a faucet.
                </div>
            )}
            {sponsored && balance === 0n && !row?.loading && (
                <div className="hint" style={{ marginTop: 6, color: "var(--success)" }}>
                    ✓ Fees are sponsored on this network — you can send, deploy, and mint without
                    any fee juice. Bridging is optional (for self-sufficiency).
                </div>
            )}
            {row?.error && <div className="error" style={{ marginTop: 6 }}>{row.error}</div>}
        </div>
    );
}

function TokenRow({ row, tab, onRemove }: { row: RowState; tab: Tab; onRemove: () => void }) {
    const { token, balance } = row;
    const value = tab === "private" ? balance.private : balance.public;
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
                <button
                    className="muted"
                    style={{ fontSize: 10, marginTop: 4, cursor: "pointer" }}
                    onClick={onRemove}
                    title="Remove from list"
                >
                    remove
                </button>
            </div>
        </div>
    );
}

function AddTokenDialog({
    networkId,
    onClose,
    onAdded,
}: {
    networkId: import("../../lib/aztec/networks").AztecNetwork["id"];
    onClose: () => void;
    onAdded: () => void;
}) {
    const [address, setAddress] = useState("");
    const [symbol, setSymbol] = useState("");
    const [name, setName] = useState("");
    const [decimals, setDecimals] = useState("18");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit() {
        setError(null);
        setBusy(true);
        try {
            const d = Number(decimals);
            if (!Number.isInteger(d) || d < 0 || d > 30) {
                throw new Error("Decimals must be an integer 0-30.");
            }
            await addToken(networkId, {
                address: address.trim(),
                symbol: symbol.trim(),
                name: name.trim(),
                decimals: d,
            });
            onAdded();
            onClose();
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
                <div style={{ fontWeight: 600 }}>Import token</div>
                <div className="field">
                    <label>Contract address</label>
                    <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                    <div className="field" style={{ flex: 1 }}>
                        <label>Symbol</label>
                        <input value={symbol} onChange={(e) => setSymbol(e.target.value)} />
                    </div>
                    <div className="field" style={{ width: 90 }}>
                        <label>Decimals</label>
                        <input value={decimals} onChange={(e) => setDecimals(e.target.value)} />
                    </div>
                </div>
                <div className="field">
                    <label>Name</label>
                    <input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                {error && <div className="error">{error}</div>}
                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-ghost btn-block" onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        className="btn btn-primary btn-block"
                        disabled={busy || !address || !symbol}
                        onClick={submit}
                    >
                        {busy ? "Adding…" : "Add"}
                    </button>
                </div>
            </div>
        </div>
    );
}
