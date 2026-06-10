import { useCallback, useEffect, useState } from "react";
import { Header, shortAddress } from "../components/Header";
import { Identicon } from "../components/Identicon";
import { ArrowLeftIcon, PlusIcon, TrashIcon } from "../components/icons";
import { useWallet } from "../../lib/state/walletContext";
import {
    addContact,
    listContacts,
    removeContact,
    type Contact,
} from "../../lib/aztec/contacts";

export function Contacts({ onBack }: { onBack: () => void }) {
    const { wallet, network } = useWallet();
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [showAdd, setShowAdd] = useState(false);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            setContacts(await listContacts(network.id));
        } finally {
            setLoading(false);
        }
    }, [network.id]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    async function handleAdd(label: string, address: string) {
        await addContact(network.id, { label, address, source: "manual" }, wallet);
        await refresh();
    }

    async function handleRemove(address: string) {
        if (!confirm("Remove this contact?")) return;
        await removeContact(network.id, address, wallet);
        await refresh();
    }

    return (
        <>
            <Header />
            <div className="content">
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                    }}
                >
                    <button
                        className="muted"
                        style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                        onClick={onBack}
                    >
                        <ArrowLeftIcon size={14} /> Back
                    </button>
                    <button
                        className="btn btn-primary"
                        style={{ padding: "6px 12px", fontSize: 12 }}
                        onClick={() => setShowAdd(true)}
                    >
                        <PlusIcon size={14} /> Add
                    </button>
                </div>

                <div>
                    <div style={{ fontWeight: 600, fontSize: 16 }}>Contacts</div>
                    <div className="muted" style={{ marginTop: 4, lineHeight: 1.5 }}>
                        Your address book for sending, and for receiving privately. Aztec only
                        discovers private notes from registered senders, so to receive a private
                        transfer from someone you haven't sent to yet, add them here first. Anyone
                        you've sent to is tracked automatically; public transfers always arrive.
                    </div>
                </div>

                {loading && <div className="spinner" />}

                {!loading && contacts.length === 0 && (
                    <div className="card hint" style={{ textAlign: "center" }}>
                        <div style={{ marginBottom: 8 }}>No contacts yet.</div>
                        <div>
                            Add anyone you want to receive private transfers from. Aztec can't
                            detect a private note from an unregistered sender.
                        </div>
                    </div>
                )}

                {contacts.map((c) => (
                    <div key={c.address} className="token-row">
                        <div className="token-meta" style={{ minWidth: 0, flex: 1 }}>
                            <Identicon address={c.address} size={36} />
                            <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {c.label}
                                </div>
                                <div className="muted" style={{ fontFamily: "ui-monospace, monospace" }}>
                                    {shortAddress(c.address, 8, 6)}
                                </div>
                            </div>
                        </div>
                        <button
                            className="icon-btn"
                            onClick={() => handleRemove(c.address)}
                            title="Remove contact"
                            aria-label="Remove contact"
                        >
                            <TrashIcon size={14} />
                        </button>
                    </div>
                ))}

                <div className="hint" style={{ marginTop: 8, lineHeight: 1.5 }}>
                    <b>Privacy note:</b> contacts live only on this device and adding one doesn't
                    notify them. Private funds from a sender you haven't added won't be detected
                    until you add them; public funds always arrive.
                </div>
            </div>

            {showAdd && (
                <AddContactDialog onClose={() => setShowAdd(false)} onAdd={handleAdd} />
            )}
        </>
    );
}

function AddContactDialog({
    onClose,
    onAdd,
}: {
    onClose: () => void;
    onAdd: (label: string, address: string) => Promise<void>;
}) {
    const [label, setLabel] = useState("");
    const [address, setAddress] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit() {
        setError(null);
        setBusy(true);
        try {
            await onAdd(label, address);
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
                <div style={{ fontWeight: 600 }}>Add contact</div>
                <div className="field">
                    <label>Label</label>
                    <input
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        placeholder="e.g. Alice"
                        maxLength={32}
                        autoFocus
                    />
                </div>
                <div className="field">
                    <label>Aztec address</label>
                    <input
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        placeholder="0x…"
                        style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
                    />
                </div>
                {error && <div className="error">{error}</div>}
                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-ghost btn-block" onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        className="btn btn-primary btn-block"
                        disabled={busy || !label || !address}
                        onClick={submit}
                    >
                        {busy ? "Saving…" : "Save"}
                    </button>
                </div>
            </div>
        </div>
    );
}
