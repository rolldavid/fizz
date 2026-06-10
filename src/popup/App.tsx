import { useEffect, useState } from "react";
import { WalletProvider, useWallet } from "../lib/state/walletContext";
import { ThemeProvider } from "../lib/state/themeContext";
import { Onboarding } from "./pages/Onboarding";
import { Unlock } from "./pages/Unlock";
import { Home } from "./pages/Home";
import { Send } from "./pages/Send";
import { Receive } from "./pages/Receive";
import { Bridge } from "./pages/Bridge";
import { Deploy } from "./pages/Deploy";
import { Mint } from "./pages/Mint";
import { Convert, type ConvertTarget } from "./pages/Convert";
import { Contacts } from "./pages/Contacts";
import { RevealPhrase } from "./pages/RevealPhrase";
import { vaultStore } from "../lib/vault/store";
import { routeFromHash } from "../lib/runtime/standalone";

type Route =
    | "home"
    | "send"
    | "receive"
    | "bridge"
    | "deploy"
    | "mint"
    | "convert"
    | "contacts"
    | "reveal";

function LoadingScreen() {
    const { network, networks, setNetwork, lock, bootError, retryBoot } = useWallet();

    if (bootError) {
        return (
            <div className="app">
                <div className="header">
                    <div className="brand">
                        <img src="/fizzmark.png" alt="" className="brand-mark-img" /> Fizz
                    </div>
                </div>
                <div className="content">
                    <div className="card" style={{ borderColor: "var(--danger)" }}>
                        <div style={{ fontWeight: 600, marginBottom: 6 }}>
                            Couldn't reach {network.name}
                        </div>
                        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                            {bootError}
                        </div>
                    </div>
                    <div className="field">
                        <label>Switch network</label>
                        <select
                            value={network.id}
                            onChange={(e) => setNetwork(e.target.value as any)}
                        >
                            {networks.map((n) => (
                                <option key={n.id} value={n.id}>
                                    {n.name} — {n.description}
                                </option>
                            ))}
                        </select>
                    </div>
                    <button className="btn btn-primary btn-block" onClick={retryBoot}>
                        Try again
                    </button>
                    <button className="btn btn-ghost btn-block" onClick={lock}>
                        Lock wallet
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="app bubble-host">
            <div className="fizz-bubbles" aria-hidden>
                <span /><span /><span /><span /><span /><span />
            </div>
            <div className="center">
                <img src="/fizzmark.png" alt="" width={48} height={48} />
                <div className="spinner" />
                <div style={{ fontWeight: 500 }}>Connecting to {network.name}</div>
                <div className="muted" style={{ maxWidth: 260 }}>
                    Getting the bubbles going — your private prover loads right in the browser.
                    First run takes the longest.
                </div>
                <button
                    className="btn btn-ghost"
                    style={{ marginTop: 8, fontSize: 11, padding: "6px 12px" }}
                    onClick={lock}
                >
                    Cancel and lock
                </button>
            </div>
        </div>
    );
}

function Shell() {
    const { status, account } = useWallet();
    // Deep-link support: a standalone window / tab opened at index.html#deploy
    // lands on that page after unlock (the toolbar popup has no hash → home).
    const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
    // The token + direction for the Convert screen (set when a token row's
    // convert icon is tapped).
    const [convertTarget, setConvertTarget] = useState<ConvertTarget | null>(null);
    // Live hash navigation too: changing the hash on an already-open wallet
    // page routes without a reload (used by deep links into a running session).
    useEffect(() => {
        const onHash = () => setRoute(routeFromHash(window.location.hash));
        window.addEventListener("hashchange", onHash);
        return () => window.removeEventListener("hashchange", onHash);
    }, []);

    const openConvert = (target: ConvertTarget) => {
        setConvertTarget(target);
        setRoute("convert");
    };

    if (status === "uninitialized") return <Onboarding />;
    if (status === "locked") return <Unlock />;
    if (status === "unlocking" || status === "loading") return <LoadingScreen />;

    if (!account) {
        return (
            <div className="app">
                <div className="center">
                    <div className="muted">No account loaded.</div>
                </div>
            </div>
        );
    }

    return (
        <div className="app fade-in">
            {route === "home" && <Home onNavigate={setRoute} onConvert={openConvert} />}
            {route === "send" && <Send onBack={() => setRoute("home")} />}
            {route === "receive" && <Receive onBack={() => setRoute("home")} />}
            {route === "bridge" && <Bridge onBack={() => setRoute("home")} />}
            {/* No onDeployed navigation: Deploy renders its own "Token deployed"
                result screen; navigating here on success unmounted it before the
                user ever saw it ("deploy did nothing" in live testing). */}
            {route === "deploy" && <Deploy onBack={() => setRoute("home")} />}
            {route === "mint" && <Mint onBack={() => setRoute("home")} />}
            {route === "convert" && convertTarget && (
                <Convert target={convertTarget} onBack={() => setRoute("home")} />
            )}
            {route === "contacts" && <Contacts onBack={() => setRoute("home")} />}
            {route === "reveal" && <RevealPhrase onBack={() => setRoute("home")} />}
        </div>
    );
}

export default function App() {
    const [ready, setReady] = useState(false);

    useEffect(() => {
        vaultStore.init().then(() => setReady(true));
    }, []);

    if (!ready) {
        return (
            <div className="app">
                <div className="center">
                    <div className="spinner" />
                </div>
            </div>
        );
    }

    return (
        <ThemeProvider>
            <WalletProvider>
                <Shell />
            </WalletProvider>
        </ThemeProvider>
    );
}
