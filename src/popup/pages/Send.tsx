import { useEffect, useMemo, useRef, useState } from "react";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Header, shortAddress } from "../components/Header";
import { Identicon } from "../components/Identicon";
import { CheckIcon } from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";
import { trackOp } from "../../lib/state/activity";
import { loadTokens, type TokenEntry } from "../../lib/aztec/tokens";
import { parseUnits } from "../../lib/aztec/balances";
import { transfer, type TransferMode } from "../../lib/aztec/transfer";
import { assessFeeReadiness } from "../../lib/aztec/fee";
import { listContacts, rememberSentRecipient, type Contact } from "../../lib/aztec/contacts";

/**
 * Send screen. Recipients come from CONTACTS ONLY — there is deliberately no
 * raw address input. Pasting an address at send time is the address-poisoning
 * vector (look-alike addresses, clipboard swappers); forcing the add-contact
 * step first means every recipient was reviewed once, calmly, with the full
 * address on screen — and reuse after that is mistake-proof.
 *
 * After a send, a full confirmation screen helps the sender ONBOARD the
 * recipient: the token's contract address must be in the recipient's token
 * list before the transfer shows up — and for private sends, the recipient
 * must also add the SENDER as a contact or the note is never discovered. One
 * tap copies ready-to-paste instructions covering both.
 */
export function Send({ onBack, onAddContact }: { onBack: () => void; onAddContact: () => void }) {
    const { wallet, network, account, ensureAccountDeployed } = useWallet();
    const [tokens, setTokens] = useState<TokenEntry[]>([]);
    const [tokenAddr, setTokenAddr] = useState("");
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [recipient, setRecipient] = useState<Contact | null>(null);
    const [query, setQuery] = useState("");
    const [pickerOpen, setPickerOpen] = useState(false);
    const pickerRef = useRef<HTMLDivElement>(null);

    // Close the contact dropdown on outside click / Escape.
    useEffect(() => {
        if (!pickerOpen) return;
        const onDoc = (e: MouseEvent) => {
            if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
                setPickerOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setPickerOpen(false);
        };
        document.addEventListener("mousedown", onDoc);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDoc);
            document.removeEventListener("keydown", onKey);
        };
    }, [pickerOpen]);
    const [amount, setAmount] = useState("");
    const [privacy, setPrivacy] = useState<TransferMode>("private");
    const [busy, setBusy] = useState(false);
    /** Stage line shown above the proving progress bar (NOT on buttons). */
    const [stage, setStage] = useState("");
    const [checking, setChecking] = useState(false);
    /** Why sending is blocked: gas is incoming (wait) or absent (go get it). */
    const [gasGate, setGasGate] = useState<"incoming" | "none" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [done, setDone] = useState<{
        txHash: string;
        recipient: Contact;
        amount: string;
        token: TokenEntry;
        privacy: TransferMode;
    } | null>(null);

    useEffect(() => {
        if (!account) return;
        const addr = account.address.toString();
        loadTokens(network.id, addr).then((list) => {
            const real = list.filter((t) => t.kind !== "fee_juice");
            setTokens(real);
            if (real[0]) setTokenAddr(real[0].address);
        });
        listContacts(network.id, addr).then(setContacts);
    }, [network.id, account]);

    const token = useMemo(() => tokens.find((t) => t.address === tokenAddr), [tokens, tokenAddr]);

    const filteredContacts = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return contacts;
        return contacts.filter(
            (c) => c.label.toLowerCase().includes(q) || c.address.toLowerCase().includes(q),
        );
    }, [contacts, query]);

    /** Step 1: validate + gate on gas, then surface the full-address review. */
    async function review() {
        setError(null);
        setGasGate(null);
        if (!wallet) return setError("Wallet not loaded.");
        if (!account) return setError("Account not loaded.");
        if (!token) return setError("Pick a token.");
        if (!recipient) return setError("Pick a contact to send to.");
        try {
            const value = parseUnits(amount, token.decimals);
            if (value <= 0n) throw new Error("Amount must be greater than zero.");
        } catch (e) {
            return setError(e instanceof Error ? e.message : String(e));
        }
        // Gas gate BEFORE building anything: a send with no fee source dies
        // deep in the SDK with an unhelpful schema error. If a bridge claim is
        // mid-flight the answer is "wait", not "go get gas".
        setChecking(true);
        try {
            const readiness = await assessFeeReadiness(wallet, network, account.address);
            if (readiness.kind !== "ready") {
                setGasGate(readiness.kind);
                return;
            }
            setConfirming(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setChecking(false);
        }
    }

    async function doSubmit() {
        setError(null);
        if (!wallet || !account || !token || !recipient) return;
        const sentTo = recipient;
        const sentToken = token;
        const sentAmount = amount;
        const sentPrivacy = privacy;
        setBusy(true);
        try {
            // trackOp: proving + inclusion can exceed the 5-min idle window;
            // the auto-lock defers while this runs instead of killing the tx.
            const result = await trackOp(async () => {
                const value = parseUnits(sentAmount, sentToken.decimals);
                const sender = account.address;
                if (!account.isDeployed) {
                    // First transaction ever: the account contract must be
                    // published + initialized on-chain before it can send.
                    setStage("Activating your account — first send only (takes a few minutes)…");
                    await ensureAccountDeployed();
                }
                setStage("Generating a private proof on your device (~45 seconds)…");
                return transfer({
                    wallet,
                    network,
                    sender,
                    tokenAddress: AztecAddress.fromString(sentToken.address),
                    to: AztecAddress.fromString(sentTo.address),
                    amount: value,
                    mode: sentPrivacy,
                });
            });
            // Remember the recipient so a reciprocal private payment from them
            // is discoverable on the fast tagged path.
            void rememberSentRecipient(network.id, account.address.toString(), sentTo.address, wallet);
            setConfirming(false);
            setDone({
                txHash: result.txHash,
                recipient: sentTo,
                amount: sentAmount,
                token: sentToken,
                privacy: sentPrivacy,
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    if (done && account) {
        return (
            <SentConfirmation
                done={done}
                senderAddress={account.address.toString()}
                onDone={onBack}
                onSendAnother={() => {
                    setDone(null);
                    setAmount("");
                }}
            />
        );
    }

    return (
        <>
            <Header />
            <div className="content">
                <button className="muted" style={{ alignSelf: "flex-start" }} onClick={onBack}>
                    ← Back
                </button>
                <div style={{ fontWeight: 600, fontSize: 16 }}>Send</div>

                <div className="field">
                    <label>Token</label>
                    <select value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value)}>
                        {tokens.length === 0 && <option value="">No tokens imported</option>}
                        {tokens.map((t) => (
                            <option key={t.address} value={t.address}>
                                {t.symbol}: {t.name}
                            </option>
                        ))}
                    </select>
                </div>

                {/* Recipient — contacts only. */}
                <div className="field" style={{ marginBottom: 0 }}>
                    <label>To</label>
                </div>
                {recipient ? (
                    <div className="token-row" style={{ width: "100%" }}>
                        <div className="token-meta" style={{ minWidth: 0 }}>
                            <Identicon address={recipient.address} size={32} />
                            <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 600 }}>{recipient.label}</div>
                                <div className="muted" style={{ fontFamily: "ui-monospace, monospace" }}>
                                    {shortAddress(recipient.address, 8, 6)}
                                </div>
                            </div>
                        </div>
                        <button
                            className="btn btn-ghost"
                            style={{ padding: "4px 10px", fontSize: 11 }}
                            onClick={() => setRecipient(null)}
                        >
                            Change
                        </button>
                    </div>
                ) : (
                    /* Combobox: the input filters, the anchored dropdown lists
                       ALL contacts (or just the matches when a term is typed). */
                    <div className="contact-combo" ref={pickerRef}>
                        <input
                            value={query}
                            onFocus={() => setPickerOpen(true)}
                            onClick={() => setPickerOpen(true)}
                            onChange={(e) => {
                                setQuery(e.target.value);
                                setPickerOpen(true);
                            }}
                            placeholder={
                                contacts.length === 0
                                    ? "No contacts yet — add one below"
                                    : "Pick or search a contact…"
                            }
                        />
                        {pickerOpen && (
                            <div className="contact-combo-dropdown" role="listbox">
                                {filteredContacts.map((c) => (
                                    <button
                                        key={c.address}
                                        className="contact-combo-option"
                                        role="option"
                                        onClick={() => {
                                            setRecipient(c);
                                            setPickerOpen(false);
                                            setQuery("");
                                        }}
                                    >
                                        <Identicon address={c.address} size={26} />
                                        <div style={{ minWidth: 0, flex: 1 }}>
                                            <div style={{ fontWeight: 500 }}>{c.label}</div>
                                            <div
                                                className="muted"
                                                style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}
                                            >
                                                {shortAddress(c.address, 6, 4)}
                                            </div>
                                        </div>
                                    </button>
                                ))}
                                {filteredContacts.length === 0 && (
                                    <div className="muted" style={{ fontSize: 12, padding: "8px 10px" }}>
                                        {query.trim()
                                            ? "No contacts match."
                                            : "No contacts yet. Sending is contacts-only — add the recipient's address once, then reuse it safely."}
                                    </div>
                                )}
                                <button
                                    className="contact-combo-option contact-combo-add"
                                    onClick={onAddContact}
                                >
                                    + New contact
                                </button>
                            </div>
                        )}
                    </div>
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

                <div className="hint">
                    {privacy === "private"
                        ? "Sent privately. Amount, sender and recipient stay hidden on-chain. The recipient sees it once they've added you."
                        : "Sent publicly. Visible on-chain, like a normal token transfer. Arrives instantly, no setup."}
                </div>

                {error && !confirming && <div className="error">{error}</div>}

                {gasGate === "incoming" && (
                    <div className="card card-accent" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ fontWeight: 600 }}>Your gas is on the way</div>
                        <div className="hint" style={{ margin: 0 }}>
                            A bridge to this account is still landing — the gas usually becomes
                            usable within a few minutes, and this send will use it automatically.
                            Check again shortly.
                        </div>
                        <button
                            className="btn btn-ghost"
                            style={{ fontSize: 12, padding: "6px 12px", alignSelf: "flex-start" }}
                            onClick={() => void review()}
                        >
                            Check again
                        </button>
                    </div>
                )}
                {gasGate === "none" && (
                    <div className="card card-accent" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ fontWeight: 600 }}>You need gas first</div>
                        <div className="hint" style={{ margin: 0 }}>
                            This account has no fee juice, and every Aztec transaction needs some.
                            Get gas, wait for it to land (it arrives automatically), then send.
                        </div>
                        <a
                            className="btn btn-primary btn-block"
                            href="https://fizzwallet.com/bridge"
                            target="_blank"
                            rel="noreferrer"
                        >
                            Get gas ↗
                        </a>
                    </div>
                )}

                <button
                    className="btn btn-primary btn-block"
                    disabled={busy || checking || !token || !amount || !recipient}
                    onClick={() => void review()}
                >
                    {busy ? "Sending…" : checking ? "Checking…" : "Review send"}
                </button>
                {busy && (
                    <div className="hint">
                        Proof generation runs locally in your browser. This can take 10-30s the
                        first time as the proving keys load.
                    </div>
                )}

                {confirming && token && recipient && (
                    <ConfirmSendModal
                        recipient={recipient.address}
                        amount={amount}
                        symbol={token.symbol}
                        privacy={privacy}
                        contact={recipient}
                        busy={busy}
                        stage={stage}
                        error={error}
                        onCancel={() => {
                            if (!busy) {
                                setConfirming(false);
                                setError(null);
                            }
                        }}
                        onConfirm={doSubmit}
                    />
                )}
            </div>
        </>
    );
}

/**
 * Time-based progress for client-side proving. Proof generation is ~45s of
 * silence that reads as a hang; a bar moving toward done reads as work. It
 * eases to 95% over PROVING_ESTIMATE_S and holds there — never claiming done
 * before the receipt actually lands (slow machines / first-run key loading).
 */
const PROVING_ESTIMATE_S = 45;
function ProvingProgress({ status }: { status: string }) {
    const [pct, setPct] = useState(0);
    useEffect(() => {
        const started = Date.now();
        const t = window.setInterval(() => {
            const elapsed = (Date.now() - started) / 1000;
            setPct(Math.min(95, (elapsed / PROVING_ESTIMATE_S) * 100));
        }, 250);
        return () => window.clearInterval(t);
    }, []);
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {/* Stage line lives HERE — buttons stay short ("Sending…"). */}
            <div className="muted" style={{ fontSize: 12 }}>{status}</div>
            <div className="progress-track">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
        </div>
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
    stage,
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
    stage: string;
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
                                Not in your contacts. Verify every character:
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

                {busy && <ProvingProgress status={stage} />}

                {error && <div className="error">{error}</div>}

                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-ghost btn-block" disabled={busy} onClick={onCancel}>
                        Cancel
                    </button>
                    <button className="btn btn-primary btn-block" disabled={busy} onClick={onConfirm}>
                        {busy ? "Sending…" : "Confirm & send"}
                    </button>
                </div>
            </div>
        </div>
    );
}

/** Ready-to-paste onboarding text for the recipient. */
function shareInstructions(args: {
    amount: string;
    token: TokenEntry;
    privacy: TransferMode;
    senderAddress: string;
}): string {
    const { amount, token, privacy, senderAddress } = args;
    const lines = [
        `I just sent you ${amount} ${token.symbol} on Aztec${privacy === "private" ? " (privately)" : ""} with Fizz (https://fizzwallet.com).`,
        ``,
        `To see it in your wallet:`,
        ``,
        `1. Import the token (Home → + Import) using this contract address:`,
        token.address,
    ];
    if (privacy === "private") {
        lines.push(
            ``,
            `2. Add me as a contact (Menu → Contacts) so the private transfer is discovered — my address:`,
            senderAddress,
        );
    }
    return lines.join("\n");
}

/**
 * Post-send confirmation. The job here is recipient onboarding: a transfer the
 * recipient can't SEE might as well not have happened. The token address (and
 * for private sends, the sender address) is one tap away to share.
 */
function SentConfirmation({
    done,
    senderAddress,
    onDone,
    onSendAnother,
}: {
    done: {
        txHash: string;
        recipient: Contact;
        amount: string;
        token: TokenEntry;
        privacy: TransferMode;
    };
    senderAddress: string;
    onDone: () => void;
    onSendAnother: () => void;
}) {
    const { txHash, recipient, amount, token, privacy } = done;
    const [copied, setCopied] = useState<"address" | "instructions" | null>(null);

    async function copy(kind: "address" | "instructions") {
        const text =
            kind === "address"
                ? token.address
                : shareInstructions({ amount, token, privacy, senderAddress });
        await navigator.clipboard.writeText(text);
        setCopied(kind);
        setTimeout(() => setCopied(null), 1800);
    }

    return (
        <>
            <Header />
            <div className="content">
                <div style={{ textAlign: "center", marginTop: 16 }}>
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
                    <div style={{ fontWeight: 600, fontSize: 18 }}>
                        {amount} {token.symbol} sent
                    </div>
                    <div className="muted" style={{ marginTop: 4 }}>
                        to {recipient.label} · {privacy === "private" ? "🔒 private" : "public"}
                    </div>
                </div>

                <div
                    className="muted"
                    style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 10,
                        wordBreak: "break-all",
                        textAlign: "center",
                    }}
                    title="Transaction hash"
                >
                    {txHash}
                </div>

                <div className="card card-accent" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ fontWeight: 600 }}>Help {recipient.label} see it</div>
                    <div className="hint" style={{ margin: 0 }}>
                        {privacy === "private"
                            ? `${token.symbol} shows up for them only after they import the token AND add you as a contact (private transfers are invisible until the sender is registered).`
                            : `${token.symbol} shows up for them only after they import the token's contract address into their list.`}
                    </div>
                    <div className="muted" style={{ fontSize: 11 }}>
                        Token contract · tap to copy
                    </div>
                    {/* The address box IS the copy control; the ✓ overlays so
                        nothing shifts. */}
                    <button
                        className="address-copy-box"
                        onClick={() => copy("address")}
                        title={copied === "address" ? "Copied" : "Copy token address"}
                        aria-label="Copy token address"
                    >
                        {token.address}
                        {copied === "address" && (
                            <span className="address-copy-check" aria-hidden>
                                ✓
                            </span>
                        )}
                    </button>
                    {privacy === "private" && (
                        <button
                            className="btn btn-primary btn-block"
                            style={{ fontSize: 12 }}
                            onClick={() => copy("instructions")}
                        >
                            {copied === "instructions"
                                ? "✓ Copied — paste it to them"
                                : "Copy instructions to share"}
                        </button>
                    )}
                </div>

                <button className="btn btn-ghost btn-block" onClick={onSendAnother}>
                    Send another
                </button>
                <button className="btn btn-primary btn-block" onClick={onDone}>
                    Done
                </button>
            </div>
        </>
    );
}
