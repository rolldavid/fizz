import { useEffect, useMemo, useState } from "react";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Header, shortAddress } from "../components/Header";
import { Identicon } from "../components/Identicon";
import { StandaloneGuard } from "../components/StandaloneGuard";
import { BookmarkIcon, CheckIcon } from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";
import { trackOp } from "../../lib/state/activity";
import { loadTokens, type TokenEntry } from "../../lib/aztec/tokens";
import { parseUnits } from "../../lib/aztec/balances";
import { shield, transfer, unshield, type TransferMode } from "../../lib/aztec/transfer";
import {
    addContact,
    findContact,
    listContacts,
    rememberSentRecipient,
    type Contact,
} from "../../lib/aztec/contacts";

/**
 * Send screen — two clearly-separated intents:
 *   • "Send to someone"  → pay another address, with a Private/Public toggle.
 *   • "Convert"          → move YOUR OWN balance between private and public
 *                          (shield / unshield), framed as "Make private / public".
 *
 * Previously these four modes were peer tabs (Private/Public/Shield/Unshield),
 * which mixed "pay someone" with "convert my own funds" and used jargon. The
 * two-level model maps to the same underlying transfer/shield/unshield calls.
 */
type Intent = "send" | "convert";

export function Send({ onBack }: { onBack: () => void }) {
    const { wallet, network, account, ensureAccountDeployed } = useWallet();
    const [tokens, setTokens] = useState<TokenEntry[]>([]);
    const [tokenAddr, setTokenAddr] = useState("");
    const [to, setTo] = useState("");
    const [amount, setAmount] = useState("");
    const [intent, setIntent] = useState<Intent>("send");
    const [privacy, setPrivacy] = useState<TransferMode>("private");
    const [direction, setDirection] = useState<"shield" | "unshield">("shield");
    const [busy, setBusy] = useState(false);
    const [busyText, setBusyText] = useState("Proving + sending…");
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<{ txHash: string; recipient: string } | null>(null);
    const [contacts, setContacts] = useState<Contact[]>([]);
    /** Canonical recipient under review (full-address confirm step), or null. */
    const [confirming, setConfirming] = useState<string | null>(null);

    useEffect(() => {
        loadTokens(network.id).then((list) => {
            const real = list.filter((t) => t.kind !== "fee_juice");
            setTokens(real);
            if (real[0]) setTokenAddr(real[0].address);
        });
        listContacts(network.id).then(setContacts);
    }, [network.id]);

    const token = useMemo(() => tokens.find((t) => t.address === tokenAddr), [tokens, tokenAddr]);
    const needsRecipient = intent === "send";

    // Filter contacts by typed input — both label and address are matched.
    const filteredContacts = useMemo(() => {
        const q = to.trim().toLowerCase();
        if (!q) return contacts;
        return contacts.filter(
            (c) => c.label.toLowerCase().includes(q) || c.address.toLowerCase().includes(q),
        );
    }, [contacts, to]);

    /**
     * Step 1: validate inputs and — for sends to another address — surface a
     * full-address review screen before anything signs. Truncated addresses are
     * an address-poisoning vector: the user must see the COMPLETE recipient.
     * Converts (self-directed) skip review and submit directly.
     */
    function review() {
        setError(null);
        setDone(null);
        if (!wallet) return setError("Wallet not loaded.");
        if (!account) return setError("Account not loaded.");
        if (!token) return setError("Pick a token.");
        try {
            const value = parseUnits(amount, token.decimals);
            if (value <= 0n) throw new Error("Amount must be greater than zero.");
            if (intent === "send") {
                const recipientAddr = AztecAddress.fromString(to.trim());
                setConfirming(recipientAddr.toString());
            } else {
                void doSubmit(account.address.toString());
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }

    async function doSubmit(recipient: string) {
        setError(null);
        if (!wallet || !account || !token) return;
        setBusy(true);
        try {
            // trackOp: proving + inclusion can exceed the 5-min idle window;
            // the auto-lock defers while this runs instead of killing the tx.
            await trackOp(async () => {
                const value = parseUnits(amount, token.decimals);
                const tokenAddress = AztecAddress.fromString(token.address);
                const sender = account.address;
                if (!account.isDeployed) {
                    // First transaction ever: the account contract must be
                    // published + initialized on-chain before it can send.
                    setBusyText("Activating your account (one-time setup)…");
                    await ensureAccountDeployed();
                }
                setBusyText("Proving + sending…");
                let result: { txHash: string };
                if (intent === "send") {
                    const recipientAddr = AztecAddress.fromString(recipient);
                    result = await transfer({
                        wallet, network, sender, tokenAddress, to: recipientAddr, amount: value, mode: privacy,
                    });
                    // Remember the recipient so a reciprocal private payment from them
                    // is discoverable on the fast tagged path — no naming required.
                    void rememberSentRecipient(network.id, recipient, wallet);
                } else if (direction === "shield") {
                    result = await shield({ wallet, network, sender, tokenAddress, amount: value });
                } else {
                    result = await unshield({ wallet, network, sender, tokenAddress, amount: value });
                }
                setConfirming(null);
                setDone({ txHash: result.txHash, recipient });
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Header />
            <div className="content">
                <button className="muted" style={{ alignSelf: "flex-start" }} onClick={onBack}>
                    ← Back
                </button>
                <div style={{ fontWeight: 600, fontSize: 16 }}>Send</div>

                <StandaloneGuard route="send" />

                {/* Primary intent: pay someone vs convert your own balance */}
                <div className="tabs">
                    <button
                        className={`tab ${intent === "send" ? "active" : ""}`}
                        onClick={() => setIntent("send")}
                    >
                        Send to someone
                    </button>
                    <button
                        className={`tab ${intent === "convert" ? "active" : ""}`}
                        onClick={() => setIntent("convert")}
                    >
                        Convert
                    </button>
                </div>

                <div className="field">
                    <label>Token</label>
                    <select value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value)}>
                        {tokens.length === 0 && <option value="">No tokens imported</option>}
                        {tokens.map((t) => (
                            <option key={t.address} value={t.address}>
                                {t.symbol} — {t.name}
                            </option>
                        ))}
                    </select>
                </div>

                {needsRecipient && (
                    <>
                        <div className="field">
                            <label>Recipient address</label>
                            <input
                                value={to}
                                onChange={(e) => setTo(e.target.value)}
                                placeholder="0x… or pick a contact below"
                                style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
                            />
                        </div>
                        {filteredContacts.length > 0 && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                <div className="muted">Contacts</div>
                                {filteredContacts.slice(0, 4).map((c) => (
                                    <button
                                        key={c.address}
                                        className="token-row"
                                        style={{ cursor: "pointer", textAlign: "left", width: "100%" }}
                                        onClick={() => setTo(c.address)}
                                    >
                                        <div className="token-meta" style={{ minWidth: 0 }}>
                                            <Identicon address={c.address} size={28} />
                                            <div style={{ minWidth: 0 }}>
                                                <div style={{ fontWeight: 500 }}>{c.label}</div>
                                                <div
                                                    className="muted"
                                                    style={{ fontFamily: "ui-monospace, monospace" }}
                                                >
                                                    {shortAddress(c.address, 8, 6)}
                                                </div>
                                            </div>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </>
                )}

                <div className="field">
                    <label>Amount</label>
                    <input
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.0"
                    />
                </div>

                {intent === "send" && (
                    <div className="field">
                        <label>Privacy</label>
                        <div className="tabs">
                            <button
                                className={`tab private ${privacy === "private" ? "active" : ""}`}
                                onClick={() => setPrivacy("private")}
                            >
                                <span className="tab-dot" /> Private
                            </button>
                            <button
                                className={`tab ${privacy === "public" ? "active" : ""}`}
                                onClick={() => setPrivacy("public")}
                            >
                                Public
                            </button>
                        </div>
                    </div>
                )}

                {intent === "convert" && (
                    <div className="field">
                        <label>Direction</label>
                        <div className="tabs">
                            <button
                                className={`tab ${direction === "shield" ? "active" : ""}`}
                                onClick={() => setDirection("shield")}
                            >
                                Make private
                            </button>
                            <button
                                className={`tab ${direction === "unshield" ? "active" : ""}`}
                                onClick={() => setDirection("unshield")}
                            >
                                Make public
                            </button>
                        </div>
                    </div>
                )}

                <div className="hint">
                    {intent === "send" && privacy === "private" &&
                        "Sent privately — amount, sender and recipient stay hidden on-chain. The recipient sees it once they've added you."}
                    {intent === "send" && privacy === "public" &&
                        "Sent publicly — visible on-chain, like a normal token transfer. Arrives instantly, no setup."}
                    {intent === "convert" && direction === "shield" &&
                        "Moves your own public balance into your private balance — it stays in your wallet."}
                    {intent === "convert" && direction === "unshield" &&
                        "Moves your own private balance back to public — it stays in your wallet."}
                </div>
                {intent === "convert" && (
                    <div className="hint" style={{ fontSize: 11 }}>
                        ⚠️ Converting touches the public ledger with your address and the exact
                        amount. Converting the same amount in and out makes the two sides easy for
                        anyone to link — vary amounts and timing if that matters to you.
                    </div>
                )}

                {error && <div className="error">{error}</div>}

                {done && (
                    <SendSuccessCard
                        txHash={done.txHash}
                        recipient={done.recipient}
                        networkId={network.id}
                        isConvert={intent === "convert"}
                        onContactSaved={(c) => setContacts((prev) => [c, ...prev])}
                    />
                )}

                <button
                    className="btn btn-primary btn-block"
                    disabled={busy || !token || !amount || (needsRecipient && !to)}
                    onClick={review}
                >
                    {busy ? busyText : intent === "send" ? "Review send" : "Convert"}
                </button>
                {busy && (
                    <div className="hint">
                        Proof generation runs locally in your browser. This can take 10-30s the
                        first time as the proving keys load.
                    </div>
                )}

                {confirming && token && (
                    <ConfirmSendModal
                        recipient={confirming}
                        amount={amount}
                        symbol={token.symbol}
                        privacy={privacy}
                        contact={contacts.find((c) => c.address === confirming)}
                        busy={busy}
                        busyText={busyText}
                        error={error}
                        onCancel={() => {
                            if (!busy) {
                                setConfirming(null);
                                setError(null);
                            }
                        }}
                        onConfirm={() => doSubmit(confirming)}
                    />
                )}
            </div>
        </>
    );
}

/**
 * Full-address review before signing. Defends against address poisoning:
 * look-alike addresses share truncated head/tail, so the COMPLETE address (and
 * its identicon) is shown and the user explicitly confirms.
 */
function ConfirmSendModal({
    recipient,
    amount,
    symbol,
    privacy,
    contact,
    busy,
    busyText,
    error,
    onCancel,
    onConfirm,
}: {
    recipient: string;
    amount: string;
    symbol: string;
    privacy: TransferMode;
    contact?: Contact;
    busy: boolean;
    busyText: string;
    error: string | null;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <div className="modal-backdrop">
            <div
                className="card fade-in"
                style={{ width: "100%", display: "flex", flexDirection: "column", gap: 12 }}
            >
                <div style={{ fontWeight: 600 }}>Confirm send</div>

                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Identicon address={recipient} size={36} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                        {contact ? (
                            <div style={{ fontWeight: 600 }}>{contact.label}</div>
                        ) : (
                            <div className="muted" style={{ fontSize: 11 }}>
                                Not in your contacts — verify every character:
                            </div>
                        )}
                    </div>
                </div>

                <div
                    style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 11,
                        wordBreak: "break-all",
                        lineHeight: 1.6,
                        background: "var(--surface-2)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: 10,
                    }}
                >
                    {recipient}
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <div className="muted">Amount</div>
                    <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                        {amount} {symbol}
                    </div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <div className="muted">Visibility</div>
                    <div style={{ fontWeight: 500 }}>
                        {privacy === "private" ? "🔒 Private" : "Public (on-chain)"}
                    </div>
                </div>

                <div className="hint">
                    Transfers are irreversible. There is no way to claw back funds sent to the
                    wrong address.
                </div>

                {error && <div className="error">{error}</div>}

                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-ghost btn-block" disabled={busy} onClick={onCancel}>
                        Cancel
                    </button>
                    <button className="btn btn-primary btn-block" disabled={busy} onClick={onConfirm}>
                        {busy ? busyText : "Confirm & send"}
                    </button>
                </div>
            </div>
        </div>
    );
}

function SendSuccessCard({
    txHash,
    recipient,
    networkId,
    isConvert,
    onContactSaved,
}: {
    txHash: string;
    recipient: string;
    networkId: import("../../lib/aztec/networks").AztecNetwork["id"];
    isConvert: boolean;
    onContactSaved: (c: Contact) => void;
}) {
    const { wallet } = useWallet();
    const [existing, setExisting] = useState<Contact | undefined>(undefined);
    const [checking, setChecking] = useState(true);
    const [label, setLabel] = useState("");
    const [saving, setSaving] = useState(false);
    const [savedLabel, setSavedLabel] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // Converts go to your own address — no contact to save.
        if (isConvert) {
            setChecking(false);
            return;
        }
        let cancelled = false;
        setChecking(true);
        findContact(networkId, recipient).then((c) => {
            if (cancelled) return;
            setExisting(c);
            setChecking(false);
        });
        return () => {
            cancelled = true;
        };
    }, [networkId, recipient, isConvert]);

    async function save() {
        setError(null);
        setSaving(true);
        try {
            const c = await addContact(
                networkId,
                { address: recipient, label, source: "sent" },
                wallet,
            );
            onContactSaved(c);
            setSavedLabel(c.label);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="card" style={{ borderColor: "var(--success)" }}>
            <div style={{ color: "var(--success)", marginBottom: 4, fontWeight: 500 }}>
                {isConvert ? "Converted" : "Confirmed"}
            </div>
            <div
                style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 11,
                    wordBreak: "break-all",
                    marginBottom: 8,
                    color: "var(--text-dim)",
                }}
            >
                {txHash}
            </div>

            {!isConvert && !checking && !existing && !savedLabel && (
                <div
                    className="fade-in"
                    style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 4 }}
                >
                    <div className="muted" style={{ marginBottom: 6 }}>
                        Save {shortAddress(recipient, 8, 6)} as a contact?
                    </div>
                    <div className="hint" style={{ marginBottom: 8 }}>
                        Optional — gives them a name for quick-pick. They're already on your
                        known-sender list, so a private payment back to you will be detected
                        either way.
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                        <input
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            placeholder="Label (e.g. Alice)"
                            maxLength={32}
                            style={{ flex: 1 }}
                        />
                        <button
                            className="btn btn-primary"
                            style={{ padding: "8px 12px" }}
                            disabled={!label || saving}
                            onClick={save}
                        >
                            <BookmarkIcon size={14} />
                            {saving ? "…" : "Save"}
                        </button>
                    </div>
                    {error && <div className="error" style={{ marginTop: 6 }}>{error}</div>}
                </div>
            )}

            {savedLabel && (
                <div
                    className="fade-in"
                    style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--success)" }}
                >
                    <CheckIcon size={14} />
                    Saved as “{savedLabel}”
                </div>
            )}

            {!isConvert && existing && (
                <div className="muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <BookmarkIcon size={12} />
                    Sent to <b style={{ color: "var(--text)" }}>{existing.label}</b>
                </div>
            )}
        </div>
    );
}
