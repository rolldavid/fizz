import { useState } from "react";
import { useWallet } from "../../lib/state/walletContext";
import { vaultStore } from "../../lib/vault/store";
import { describeError } from "../../lib/errors";

export function Unlock() {
    const { unlockWithPasskey, unlockWithPassphrase, destroy } = useWallet();
    const method = vaultStore.method();
    const [passphrase, setPassphrase] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

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

    return (
        <div className="app bubble-host">
            <div className="fizz-bubbles" aria-hidden>
                <span /><span /><span /><span /><span /><span />
            </div>
            <div className="content" style={{ paddingTop: 40 }}>
                <img src="/fizzlogo.svg" alt="Fizz" className="brand-logo" />
                <p className="hint" style={{ textAlign: "center" }}>
                    Locked tight. Pop it open to get back to your tokens.
                </p>
                {method === "passkey" && (
                    <button
                        className="btn btn-primary btn-block"
                        disabled={busy}
                        onClick={() => run(unlockWithPasskey)}
                    >
                        {busy ? "Waiting for passkey…" : "Unlock with passkey"}
                    </button>
                )}
                {method === "passphrase" && (
                    <>
                        <div className="field">
                            <label>Passphrase</label>
                            <input
                                type="password"
                                value={passphrase}
                                onChange={(e) => setPassphrase(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") run(() => unlockWithPassphrase(passphrase));
                                }}
                            />
                        </div>
                        <button
                            className="btn btn-primary btn-block"
                            disabled={busy || !passphrase}
                            onClick={() => run(() => unlockWithPassphrase(passphrase))}
                        >
                            {busy ? "Unlocking…" : "Unlock"}
                        </button>
                    </>
                )}
                {error && <div className="error">{error}</div>}
                <div style={{ marginTop: "auto", paddingTop: 16 }}>
                    <button
                        className="btn btn-ghost btn-block"
                        onClick={() => {
                            if (confirm("Wipe this wallet from the extension? You will need your 12-word phrase to restore.")) {
                                destroy();
                            }
                        }}
                    >
                        Forget wallet on this device
                    </button>
                </div>
            </div>
        </div>
    );
}
