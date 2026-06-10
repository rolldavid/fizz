import { useMemo, useState } from "react";
import { useWallet } from "../../lib/state/walletContext";
import { isValidMnemonic, newMnemonic } from "../../lib/vault/mnemonic";
import { passwordStrength, type PassStrength } from "../../lib/vault/passwordStrength";

/**
 * Onboarding.
 *
 * Create flow is deliberately TWO steps in this order:
 *   Step 1 — secure the wallet (passkey, or a password that must pass a strength
 *            check). The user commits to a recovery method before any secret is
 *            shown.
 *   Step 2 — write down the 12 recovery words, then finish (which actually
 *            creates the vault using the step-1 method).
 *
 * Import flow is paste-words → secure, since the words already exist.
 */
type Step = "intro" | "create-auth" | "create-words" | "import" | "import-auth";
type Method = "passkey" | "passphrase";

export function Onboarding() {
    const { createAccountWithPasskey, createAccountWithPassphrase } = useWallet();
    const [step, setStep] = useState<Step>("intro");
    const [mnemonic, setMnemonic] = useState("");
    const [importMnemonic, setImportMnemonic] = useState("");
    const [method, setMethod] = useState<Method>("passphrase");
    const [pass, setPass] = useState("");
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const generatedWords = useMemo(() => (mnemonic ? mnemonic.split(" ") : []), [mnemonic]);

    function startCreate() {
        // Generate now so the words exist by step 2; they're only shown in step 2.
        setMnemonic(newMnemonic());
        setError(null);
        setStep("create-auth");
    }

    // Step 1 (create): record the chosen method and advance to the words step.
    // No vault is created yet — that happens at the end of step 2.
    function chooseCreateMethod(m: Method) {
        setMethod(m);
        setError(null);
        setStep("create-words");
    }

    // Step 2 (create): actually create the vault with the step-1 method.
    async function finalizeCreate() {
        setError(null);
        setBusy(true);
        try {
            if (method === "passkey") {
                await createAccountWithPasskey(mnemonic.trim(), "Aztec Wallet");
            } else {
                await createAccountWithPassphrase(mnemonic.trim(), pass);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    // Import: words already entered; the auth step finalizes directly.
    async function finalizeImport(m: Method) {
        const phrase = importMnemonic.trim();
        if (!isValidMnemonic(phrase)) {
            setError("That doesn't look like a valid 12-word phrase.");
            return;
        }
        setError(null);
        setBusy(true);
        try {
            if (m === "passkey") {
                await createAccountWithPasskey(phrase, "Aztec Wallet");
            } else {
                await createAccountWithPassphrase(phrase, pass);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={`app ${step === "intro" ? "bubble-host" : ""}`}>
            {step === "intro" && (
                <div className="fizz-bubbles" aria-hidden>
                    <span /><span /><span /><span /><span /><span />
                </div>
            )}
            {step !== "intro" && (
                <div className="header">
                    <div className="brand">
                        <img src="/fizzmark.png" alt="" className="brand-mark-img" /> Fizz
                    </div>
                </div>
            )}
            <div className="content" style={step === "intro" ? { paddingTop: 48 } : undefined}>
                {step === "intro" && (
                    <>
                        <img src="/fizzlogo.svg" alt="Fizz" className="brand-logo" style={{ height: 84 }} />
                        <p
                            style={{
                                textAlign: "center",
                                fontWeight: 600,
                                fontSize: 16,
                                marginTop: -4,
                            }}
                        >
                            Tokens with sparkle. Privacy on tap.
                        </p>
                        <p className="hint" style={{ textAlign: "center" }}>
                            Fizz is a lightweight wallet for the Aztec network, made for quick,
                            low-value transactions. Your keys stay on this device; no server ever
                            sees them. (Like any light wallet, the Aztec node you connect to does
                            see your address and IP; you can point Fizz at your own node anytime.)
                        </p>
                        <p className="hint" style={{ textAlign: "center", fontSize: 11 }}>
                            🫧 Pocket change, not vaults. Keep only what you'd carry in a pocket.
                        </p>
                        <button className="btn btn-primary btn-block" onClick={startCreate}>
                            Create new wallet
                        </button>
                        <button
                            className="btn btn-ghost btn-block"
                            onClick={() => {
                                setError(null);
                                setStep("import");
                            }}
                        >
                            Import 12-word phrase
                        </button>
                    </>
                )}

                {step === "create-auth" && (
                    <>
                        <StepBadge n={1} label="Secure your wallet" />
                        <p className="hint">
                            Choose how you'll unlock this wallet. A passkey (Touch ID / Face ID /
                            PIN) is fastest and safest. You'll save your recovery phrase next.
                        </p>
                        <AuthChooser
                            pass={pass}
                            setPass={setPass}
                            confirm={confirm}
                            setConfirm={setConfirm}
                            submitLabel="Continue"
                            busy={busy}
                            onPasskey={() => chooseCreateMethod("passkey")}
                            onPassphrase={() => chooseCreateMethod("passphrase")}
                        />
                        {error && <div className="error">{error}</div>}
                        <button
                            className="btn btn-ghost btn-block"
                            style={{ marginTop: 4 }}
                            onClick={() => setStep("intro")}
                        >
                            Back
                        </button>
                    </>
                )}

                {step === "create-words" && (
                    <>
                        <StepBadge n={2} label="Save your recovery phrase" />
                        <p className="hint">
                            Write these 12 words down in order and store them somewhere safe.
                            Anyone with this phrase controls your funds. They restore your wallet
                            (on any device, in this app). Back them up before continuing.
                        </p>
                        <div className="mnemonic-grid">
                            {generatedWords.map((w, i) => (
                                <div key={i} className="mnemonic-word">
                                    {i + 1}. {w}
                                </div>
                            ))}
                        </div>
                        <button
                            className="btn btn-primary btn-block"
                            disabled={busy}
                            onClick={finalizeCreate}
                        >
                            {busy
                                ? "Setting up…"
                                : method === "passkey"
                                  ? "I've saved it. Create with passkey"
                                  : "I've saved it. Create wallet"}
                        </button>
                        {error && <div className="error">{error}</div>}
                        <button
                            className="btn btn-ghost btn-block"
                            disabled={busy}
                            onClick={() => {
                                setError(null);
                                setStep("create-auth");
                            }}
                        >
                            Back
                        </button>
                    </>
                )}

                {step === "import" && (
                    <>
                        <p className="hint">
                            Paste your 12-word recovery phrase. Words separated by spaces.
                        </p>
                        <textarea
                            rows={4}
                            placeholder="word1 word2 word3 …"
                            value={importMnemonic}
                            onChange={(e) => setImportMnemonic(e.target.value)}
                        />
                        <button
                            className="btn btn-primary btn-block"
                            disabled={!importMnemonic.trim()}
                            onClick={() => {
                                if (!isValidMnemonic(importMnemonic.trim())) {
                                    setError("That doesn't look like a valid 12-word phrase.");
                                    return;
                                }
                                setError(null);
                                setStep("import-auth");
                            }}
                        >
                            Continue
                        </button>
                        {error && <div className="error">{error}</div>}
                        <button
                            className="btn btn-ghost btn-block"
                            onClick={() => {
                                setError(null);
                                setStep("intro");
                            }}
                        >
                            Back
                        </button>
                    </>
                )}

                {step === "import-auth" && (
                    <>
                        <StepBadge n={2} label="Secure your wallet" />
                        <p className="hint">
                            Choose how you'll unlock this wallet on this device.
                        </p>
                        <AuthChooser
                            pass={pass}
                            setPass={setPass}
                            confirm={confirm}
                            setConfirm={setConfirm}
                            submitLabel="Import wallet"
                            busy={busy}
                            onPasskey={() => finalizeImport("passkey")}
                            onPassphrase={() => finalizeImport("passphrase")}
                        />
                        {error && <div className="error">{error}</div>}
                        <button
                            className="btn btn-ghost btn-block"
                            disabled={busy}
                            onClick={() => {
                                setError(null);
                                setStep("import");
                            }}
                        >
                            Back
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

function StepBadge({ n, label }: { n: number; label: string }) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
            <span
                style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--accent)",
                    border: "1px solid var(--accent)",
                    borderRadius: 999,
                    padding: "1px 8px",
                }}
            >
                Step {n} of 2
            </span>
            <span style={{ fontWeight: 600 }}>{label}</span>
        </div>
    );
}

function StrengthMeter({ strength, show }: { strength: PassStrength; show: boolean }) {
    if (!show) return null;
    // index by score 0..4
    const colors = ["var(--border)", "#ef4444", "#f59e0b", "#eab308", "#22c55e"];
    const color = colors[strength.score];
    return (
        <div style={{ marginTop: 6 }}>
            <div style={{ display: "flex", gap: 4 }}>
                {[1, 2, 3, 4].map((i) => (
                    <div
                        key={i}
                        style={{
                            height: 4,
                            flex: 1,
                            borderRadius: 2,
                            background:
                                i <= strength.score ? color : "rgba(127,127,127,0.25)",
                            transition: "background 120ms",
                        }}
                    />
                ))}
            </div>
            {strength.label && (
                <div
                    className="muted"
                    style={{
                        fontSize: 11,
                        marginTop: 4,
                        color: strength.ok ? undefined : "var(--danger)",
                    }}
                >
                    {strength.label}
                    {strength.hint ? `, ${strength.hint}` : ""}
                </div>
            )}
        </div>
    );
}

function AuthChooser({
    pass,
    setPass,
    confirm,
    setConfirm,
    submitLabel,
    busy,
    onPasskey,
    onPassphrase,
}: {
    pass: string;
    setPass: (s: string) => void;
    confirm: string;
    setConfirm: (s: string) => void;
    submitLabel: string;
    busy: boolean;
    onPasskey: () => void;
    onPassphrase: () => void;
}) {
    const strength = passwordStrength(pass);
    const match = pass.length > 0 && pass === confirm;
    const canSubmit = !busy && strength.ok && match;

    return (
        <>
            <button className="btn btn-primary btn-block" disabled={busy} onClick={onPasskey}>
                {busy ? "Setting up…" : "Use a passkey"}
            </button>
            <div className="muted" style={{ textAlign: "center" }}>
                or set a password
            </div>
            <div className="field">
                <label>Password</label>
                <input
                    type="password"
                    value={pass}
                    onChange={(e) => setPass(e.target.value)}
                    placeholder="12+ chars, mixed types or a long phrase"
                />
                <StrengthMeter strength={strength} show={pass.length > 0} />
            </div>
            <div className="field">
                <label>Confirm password</label>
                <input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && canSubmit) onPassphrase();
                    }}
                />
                {confirm.length > 0 && !match && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 4, color: "var(--danger)" }}>
                        Passwords don't match
                    </div>
                )}
            </div>
            <button
                className="btn btn-ghost btn-block"
                disabled={!canSubmit}
                onClick={onPassphrase}
            >
                {busy ? "Setting up…" : submitLabel}
            </button>
        </>
    );
}
