import { useEffect, useRef, useState } from "react";
import { Shell, ErrorBox, CopyButton, DesktopRequiredNotice, shortHex } from "../components";
import { CHROME_STORE_URL, GITHUB_URL } from "../config";
import { detectPlatform } from "../platform";
import {
    connectFizz,
    disconnectFizz,
    getConnectionStatus,
    sendToFizz,
    type LastLaunch,
} from "../extension";

/** Desktop + Chromium only — the extension can't be added/connected elsewhere. */
const PLATFORM = detectPlatform();

/** Launches recorded before this moment belong to earlier sessions. */
const PAGE_LOAD_AT = Date.now();
const POLL_MS = 5000;

// Connection state, not mere presence: "absent" = not installed; "disconnected"
// = installed but this origin isn't authorized; "connected" = the user has
// approved this origin in-wallet (address-blind — we never learn who they are).
type Conn = "checking" | "absent" | "disconnected" | "connected";
type Phase = "idle" | "submitting" | "waiting" | "done";

type Draft = {
    name: string;
    symbol: string;
    decimals: string;
    supply: string;
    supplyMode: "private" | "public";
    keepMinter: boolean;
};

const INITIAL_DRAFT: Draft = {
    name: "",
    symbol: "",
    decimals: "18",
    supply: "",
    supplyMode: "private",
    keepMinter: true,
};

function validateDraft(d: Draft): string[] {
    const errors: string[] = [];
    if (!d.name.trim()) errors.push("Name is required.");
    if (d.name.length > 30) errors.push("Name must be at most 30 characters.");
    if (!d.symbol) errors.push("Symbol is required.");
    if (!/^[A-Z0-9]{1,8}$/.test(d.symbol)) errors.push("Symbol must be 1–8 characters, A–Z and 0–9.");
    if (!/^\d{1,2}$/.test(d.decimals) || Number(d.decimals) > 18) {
        errors.push("Decimals must be a whole number between 0 and 18.");
    }
    if (d.supply !== "" && !/^\d{1,30}$/.test(d.supply)) {
        errors.push("Initial supply must be a whole number (digits only).");
    }
    return errors;
}

/** The wallet's launch-status result must be fully-formed — malformed data is an error, not a shrug. */
function validateLaunchResult(r: unknown): LastLaunch {
    const x = r as Record<string, unknown>;
    if (!x || typeof x !== "object") throw new Error("Launch status: result is not an object.");
    for (const f of ["address", "txHash", "name", "symbol"] as const) {
        if (typeof x[f] !== "string" || !x[f]) throw new Error(`Launch status: missing ${f}.`);
    }
    if (typeof x.at !== "number") throw new Error("Launch status: missing timestamp.");
    return x as unknown as LastLaunch;
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function LaunchPage() {
    const [conn, setConn] = useState<Conn>("checking");
    const [connecting, setConnecting] = useState(false);
    const [connectNote, setConnectNote] = useState<string | null>(null);
    const connectTimer = useRef<number | null>(null);
    const [draft, setDraft] = useState<Draft>(INITIAL_DRAFT);
    const [phase, setPhase] = useState<Phase>("idle");
    const [formErrors, setFormErrors] = useState<string[]>([]);
    const [fatalError, setFatalError] = useState<string | null>(null);
    const [pollNote, setPollNote] = useState<string | null>(null);
    const [waitingSince, setWaitingSince] = useState<number | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [result, setResult] = useState<LastLaunch | null>(null);
    const pollTimer = useRef<number | null>(null);

    const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

    function stopConnectPoll() {
        if (connectTimer.current !== null) {
            window.clearInterval(connectTimer.current);
            connectTimer.current = null;
        }
    }

    // Connection state, re-checked on mount and whenever the page regains focus
    // — the user approves in the wallet's OWN window, then tabs back here.
    // Skipped entirely where the extension can't run (mobile / non-Chromium):
    // probing would just report "absent" and dangle a dead Connect button.
    useEffect(() => {
        if (!PLATFORM.canUseExtension) return;
        let cancelled = false;
        const refresh = () =>
            void getConnectionStatus().then((s) => {
                if (cancelled) return;
                setConn(!s.installed ? "absent" : s.connected ? "connected" : "disconnected");
                if (s.connected) {
                    setConnecting(false);
                    stopConnectPoll();
                }
            });
        refresh();
        window.addEventListener("focus", refresh);
        return () => {
            cancelled = true;
            window.removeEventListener("focus", refresh);
            stopConnectPoll();
        };
    }, []);

    async function connect() {
        setConnectNote(null);
        try {
            await connectFizz();
        } catch (err) {
            setConnectNote(errMessage(err));
            return;
        }
        // The wallet's approval window is open now; poll until the user approves.
        // (The focus listener also catches it when they tab back.)
        setConnecting(true);
        stopConnectPoll();
        let waited = 0;
        connectTimer.current = window.setInterval(() => {
            void getConnectionStatus().then((s) => {
                waited += 2;
                if (s.connected) {
                    setConn("connected");
                    setConnecting(false);
                    stopConnectPoll();
                } else if (waited >= 120) {
                    setConnecting(false);
                    stopConnectPoll();
                    setConnectNote("Still waiting — approve the connection in the Fizz window.");
                }
            });
        }, 2000);
    }

    async function disconnect() {
        setConnectNote(null);
        try {
            await disconnectFizz();
            setConn("disconnected");
        } catch (err) {
            setConnectNote(errMessage(err));
        }
    }

    // Elapsed-time ticker while waiting (proving takes minutes; show signs of life).
    useEffect(() => {
        if (waitingSince === null) return;
        const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - waitingSince) / 1000)), 1000);
        return () => window.clearInterval(t);
    }, [waitingSince]);

    function stopPolling() {
        if (pollTimer.current !== null) {
            window.clearInterval(pollTimer.current);
            pollTimer.current = null;
        }
    }
    useEffect(() => stopPolling, []);

    function startPolling(symbol: string) {
        stopPolling();
        // Polling here is by design: the page has no other channel to learn the
        // outcome (the wallet never pushes to web pages).
        pollTimer.current = window.setInterval(() => {
            void (async () => {
                try {
                    const res = await sendToFizz<{ ok: boolean; result?: unknown; error?: string }>({
                        type: "fizz:launch-status",
                    });
                    if (!res.ok) {
                        setPollNote(`Status check refused: ${res.error ?? "unknown error"}`);
                        return;
                    }
                    if (res.result === null || res.result === undefined) return; // nothing yet — keep waiting
                    const launch = validateLaunchResult(res.result);
                    // Older results (or a different draft's) are not ours.
                    if (launch.at <= PAGE_LOAD_AT || launch.symbol !== symbol) return;
                    stopPolling();
                    setResult(launch);
                    setPhase("done");
                } catch (err) {
                    // Surface, keep polling — transient (service worker waking, popup busy proving).
                    setPollNote(errMessage(err));
                }
            })();
        }, POLL_MS);
    }

    async function launch() {
        setFormErrors([]);
        setFatalError(null);
        const errors = validateDraft(draft);
        if (errors.length > 0) {
            setFormErrors(errors);
            return;
        }
        setPhase("submitting");
        try {
            // All draft fields are STRINGS (except keepMinter) — the wallet's
            // background sanitizer drops non-string values.
            const res = await sendToFizz<{ ok: boolean; error?: string }>({
                type: "fizz:launch-token",
                draft: {
                    name: draft.name.trim(),
                    symbol: draft.symbol,
                    decimals: draft.decimals,
                    supply: draft.supply,
                    supplyMode: draft.supplyMode,
                    keepMinter: draft.keepMinter,
                },
            });
            if (!res.ok) throw new Error(res.error ?? "Fizz refused the draft.");
            setPhase("waiting");
            setWaitingSince(Date.now());
            setElapsed(0);
            startPolling(draft.symbol);
        } catch (err) {
            setPhase("idle");
            setFatalError(errMessage(err));
        }
    }

    const formDisabled =
        !PLATFORM.canUseExtension || conn !== "connected" || phase === "submitting" || phase === "waiting";

    return (
        <Shell page="launch">
            <section className="page-hero">
                <span className="pill">Testnet</span>
                <h1>
                    Launch a <em>token</em> on Aztec
                </h1>
                <p className="sub">
                    Design it here, deploy it from your Fizz wallet. This page never sees your keys — or even
                    your address. The wallet opens, you review, you confirm.
                </p>
            </section>

            <section className="card">
                <div className="card-head">
                    <h2>Your token</h2>
                    {!PLATFORM.canUseExtension && <span className="muted small">Desktop only</span>}
                    {PLATFORM.canUseExtension && conn === "checking" && <span className="muted small">Looking for Fizz…</span>}
                    {PLATFORM.canUseExtension && conn === "absent" && <span className="small" style={{ color: "var(--warn)" }}>Fizz not installed</span>}
                    {PLATFORM.canUseExtension && conn === "disconnected" && <span className="muted small">Not connected</span>}
                    {PLATFORM.canUseExtension && conn === "connected" && (
                        <span
                            className="small"
                            style={{ display: "inline-flex", gap: 10, alignItems: "center", color: "var(--ok)" }}
                        >
                            ✓ Connected
                            <button type="button" className="btn btn-ghost btn-small" onClick={() => void disconnect()}>
                                Disconnect
                            </button>
                        </span>
                    )}
                </div>

                {/* Mobile / non-Chromium: explain + stop here (no dead Connect button). */}
                {!PLATFORM.canUseExtension && (
                    <DesktopRequiredNotice reason={PLATFORM.reason === "mobile" ? "mobile" : "non-chromium"} />
                )}

                {PLATFORM.canUseExtension && conn === "absent" && (
                    <div className="note-box">
                        <strong>Install Fizz to launch.</strong> This launcher hands your draft to the Fizz
                        extension, which deploys it from YOUR wallet.{" "}
                        <a href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer">
                            Get Fizz on the Chrome Web Store
                        </a>{" "}
                        (listing coming soon) or build it from{" "}
                        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                            github.com/rolldavid/fizz
                        </a>
                        , then reload this page.
                    </div>
                )}

                {PLATFORM.canUseExtension && conn === "disconnected" && (
                    <div className="note-box">
                        <strong>Connect your wallet to launch.</strong> Fizz is installed — connect it so
                        you can deploy a public or private token from your own account. Fizz never sees
                        your address, balances, or keys, and you confirm every deploy in the wallet.
                        <div className="row-actions">
                            <button
                                type="button"
                                className="btn btn-primary btn-small"
                                disabled={connecting}
                                onClick={() => void connect()}
                            >
                                {connecting ? <span className="spin">Waiting for approval…</span> : "Connect Fizz"}
                            </button>
                            {connecting && (
                                <span className="muted small">A Fizz window opened — approve it there.</span>
                            )}
                        </div>
                        {connectNote !== null && (
                            <div className="muted small" style={{ marginTop: 8 }}>{connectNote}</div>
                        )}
                    </div>
                )}

                <div className="field">
                    <label htmlFor="t-name">Name</label>
                    <input
                        id="t-name"
                        type="text"
                        maxLength={30}
                        placeholder="Sparkle Coin"
                        value={draft.name}
                        onChange={(e) => set("name", e.target.value)}
                        disabled={formDisabled}
                    />
                    <p className="sub-label">Up to 30 characters.</p>
                </div>

                <div className="field-row">
                    <div className="field">
                        <label htmlFor="t-symbol">Symbol</label>
                        <input
                            id="t-symbol"
                            type="text"
                            maxLength={8}
                            placeholder="SPRKL"
                            value={draft.symbol}
                            onChange={(e) => set("symbol", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                            disabled={formDisabled}
                            spellCheck={false}
                            autoComplete="off"
                        />
                        <p className="sub-label">Up to 8 characters, A–Z, 0–9.</p>
                    </div>
                    <div className="field">
                        <label htmlFor="t-decimals">Decimals</label>
                        <input
                            id="t-decimals"
                            type="text"
                            inputMode="numeric"
                            maxLength={2}
                            value={draft.decimals}
                            onChange={(e) => set("decimals", e.target.value.replace(/\D/g, ""))}
                            disabled={formDisabled}
                        />
                        <p className="sub-label">Default 18.</p>
                    </div>
                </div>

                <div className="field">
                    <label htmlFor="t-supply">Initial supply (optional)</label>
                    <input
                        id="t-supply"
                        type="text"
                        inputMode="numeric"
                        placeholder="Leave empty to mint later"
                        value={draft.supply}
                        onChange={(e) => set("supply", e.target.value.replace(/\D/g, ""))}
                        disabled={formDisabled}
                    />
                    <p className="sub-label">Whole tokens, minted to you at deploy time.</p>
                </div>

                {draft.supply !== "" && (
                    <div className="field">
                        <label>Mint the initial supply as</label>
                        <div className="toggle-row" role="radiogroup" aria-label="Supply mode">
                            <button
                                type="button"
                                className={draft.supplyMode === "private" ? "active" : ""}
                                onClick={() => set("supplyMode", "private")}
                                disabled={formDisabled}
                            >
                                🔒 Private
                            </button>
                            <button
                                type="button"
                                className={draft.supplyMode === "public" ? "active" : ""}
                                onClick={() => set("supplyMode", "public")}
                                disabled={formDisabled}
                            >
                                🌐 Public
                            </button>
                        </div>
                        <p className="sub-label">
                            Either way you can shield/unshield later — every AIP-20 token has both sides.
                        </p>
                    </div>
                )}

                <div className="field">
                    <label className="checkbox-row">
                        <input
                            type="checkbox"
                            checked={draft.keepMinter}
                            onChange={(e) => set("keepMinter", e.target.checked)}
                            disabled={formDisabled}
                        />
                        <span>
                            Keep minter role
                            <br />
                            <span className="sub-label">
                                Stay able to mint more later. Un-check for a fixed supply (requires an initial supply).
                            </span>
                        </span>
                    </label>
                </div>

                {formErrors.length > 0 && (
                    <ErrorBox title="Fix these first">
                        {formErrors.map((e) => (
                            <div key={e}>• {e}</div>
                        ))}
                    </ErrorBox>
                )}
                {fatalError !== null && <ErrorBox title="Hand-off failed">{fatalError}</ErrorBox>}

                {phase !== "done" && (
                    <div className="row-actions">
                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={formDisabled}
                            onClick={() => void launch()}
                        >
                            {phase === "submitting" ? <span className="spin">Handing off…</span> : "Launch with Fizz"}
                        </button>
                        {fatalError !== null && phase === "idle" && <span className="muted small">Fix and try again.</span>}
                    </div>
                )}

                {phase === "waiting" && (
                    <div className="ok-box">
                        <strong>Fizz opened in a window</strong> — review and confirm the launch there. Proving runs
                        on your device and takes <strong>2–4 minutes</strong>.
                        <br />
                        <span className="muted small">
                            Watching for the result… {Math.floor(elapsed / 60)}m {elapsed % 60}s
                            {pollNote !== null && ` · last check: ${pollNote}`}
                        </span>
                    </div>
                )}

                {phase === "done" && result !== null && (
                    <>
                        <div className="ok-box">
                            <strong>
                                {result.name} ({result.symbol}) is live on Aztec 🫧
                            </strong>
                        </div>
                        <div className="kv-line">
                            <span className="k">Token address</span>
                            <code>{result.address}</code>
                            <CopyButton text={result.address} />
                        </div>
                        <div className="kv-line">
                            <span className="k">Deploy tx</span>
                            <code>{shortHex(result.txHash, 14, 10)}</code>
                            <CopyButton text={result.txHash} label="Copy tx hash" />
                        </div>
                        <p className="hint">
                            Find it in Fizz under your tokens. Share the address so others can add it too.
                        </p>
                    </>
                )}
            </section>

            <section className="explainers">
                <div className="explainer">
                    <div className="emoji">🪙</div>
                    <h3>A standard AIP-20 token</h3>
                    <p>
                        The Aztec token standard: every holder gets a private balance and a public balance, with
                        shielding built in. Compatible with any Aztec wallet that speaks AIP-20.
                    </p>
                </div>
                <div className="explainer">
                    <div className="emoji">👑</div>
                    <h3>You're the admin</h3>
                    <p>
                        The deploying account (your Fizz account) becomes admin. Keep the minter role to mint
                        more later, or drop it for a fixed supply.
                    </p>
                </div>
                <div className="explainer">
                    <div className="emoji">🔐</div>
                    <h3>Proven on your device</h3>
                    <p>
                        Deployment is a zero-knowledge proof generated locally in your wallet — keys never leave
                        it, and this page never sees them. That's why it takes a couple of minutes.
                    </p>
                </div>
                <div className="explainer">
                    <div className="emoji">⚡</div>
                    <h3>Free on testnet</h3>
                    <p>
                        Fees are sponsored on the Aztec testnet, so launching costs nothing. No bridging, no
                        faucet — just confirm in the wallet.
                    </p>
                </div>
            </section>
        </Shell>
    );
}
