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
import { CreateTokens } from "./pages/CreateTokens";
import { ImportToken } from "./pages/ImportToken";
import { Convert, type ConvertTarget } from "./pages/Convert";
import { Contacts } from "./pages/Contacts";
import { Connect } from "./pages/Connect";
import { Connections } from "./pages/Connections";
import { TransactionHistory } from "./pages/TransactionHistory";
import { RevealPhrase } from "./pages/RevealPhrase";
import { vaultStore } from "../lib/vault/store";
import { describeError } from "../lib/errors";
import { routeFromHash } from "../lib/runtime/standalone";
import { DeployStatusBar } from "./components/DeployStatusBar";
import { useDeployTask } from "../lib/state/deployTask";

type Route =
    | "home"
    | "send"
    | "receive"
    | "bridge"
    | "deploy"
    | "mint"
    | "create"
    | "import"
    | "convert"
    | "contacts"
    | "connect"
    | "connections"
    | "history"
    | "reveal";

function LoadingScreen() {
    const { network, networks, setNetwork, lock, bootError, retryBoot } = useWallet();

    if (bootError) {
        return (
            <div className="app">
                <div className="header">
                    <div className="brand">
                        <img src="/fizz.png" alt="" className="brand-mark-img" /> Fizz
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
                                    {n.name}: {n.description}
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
                <img src="/fizz.png" alt="" width={48} height={48} />
                <div className="spinner" />
                <div style={{ fontWeight: 500 }}>Connecting to {network.name}</div>
                <div className="muted" style={{ maxWidth: 260 }}>
                    Getting the bubbles going. Your private prover loads right in the browser.
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
    // Live token-deploy task: when one exists, every screen (except Deploy
    // itself) shows the bottom status bar so the user can roam the wallet
    // freely while proving runs, without losing the way back.
    const deployTask = useDeployTask();
    // Deep-link support: a standalone window / tab opened at index.html#deploy
    // lands on that page after unlock (the toolbar popup has no hash → home).
    const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
    // The token + direction for the Convert screen (set when a token row's
    // convert icon is tapped).
    const [convertTarget, setConvertTarget] = useState<ConvertTarget | null>(null);
    // Where a sub-page's Back returns. Recorded when entering contacts/import so
    // e.g. Receive → Add a contact → Back returns to Receive (not Home).
    const [returnTo, setReturnTo] = useState<Route>("home");
    // Auto-open the Add-contact dialog (set when arriving from Send's "new contact").
    const [contactsOpenAdd, setContactsOpenAdd] = useState(false);
    // Live hash navigation too: changing the hash on an already-open wallet
    // page routes without a reload (used by deep links into a running session).
    useEffect(() => {
        const onHash = () => setRoute(routeFromHash(window.location.hash));
        window.addEventListener("hashchange", onHash);
        return () => window.removeEventListener("hashchange", onHash);
    }, []);

    // Navigate, remembering the origin for contacts/import so their Back returns
    // there (from Receive/Send/Home); defaults to Home elsewhere.
    const go = (to: Route) => {
        if (to === "contacts" || to === "import") setReturnTo(route);
        if (to !== "contacts") setContactsOpenAdd(false);
        setRoute(to);
    };
    // Send → add a brand-new contact, then come back to Send.
    const goAddContact = () => {
        setReturnTo("send");
        setContactsOpenAdd(true);
        setRoute("contacts");
    };
    const leaveContacts = () => {
        setContactsOpenAdd(false);
        setRoute(returnTo);
    };

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

    const showDeployBar = deployTask !== null && route !== "deploy";

    return (
        <div className={`app fade-in${showDeployBar ? " has-deploy-bar" : ""}`}>
            {route === "home" && <Home onNavigate={go} onConvert={openConvert} />}
            {route === "send" && <Send onBack={() => setRoute("home")} onAddContact={goAddContact} />}
            {route === "receive" && <Receive onNavigate={go} />}
            {route === "bridge" && <Bridge onBack={() => setRoute("home")} />}
            {/* No onDeployed navigation: Deploy renders its own "Token deployed"
                result screen; navigating here on success unmounted it before the
                user ever saw it ("deploy did nothing" in live testing). */}
            {route === "deploy" && <Deploy onBack={() => setRoute("home")} />}
            {route === "mint" && <Mint onBack={() => setRoute("create")} />}
            {route === "create" && (
                <CreateTokens
                    onBack={() => setRoute("home")}
                    onDeploy={() => setRoute("deploy")}
                    onMintMore={() => setRoute("mint")}
                />
            )}
            {route === "import" && <ImportToken onBack={() => setRoute(returnTo)} />}
            {route === "convert" && convertTarget && (
                <Convert target={convertTarget} onBack={() => setRoute("home")} />
            )}
            {route === "contacts" && <Contacts onBack={leaveContacts} openAdd={contactsOpenAdd} />}
            {/* #connect is opened by the background after a page sends
                "fizz:connect"; the user approves the origin here. */}
            {route === "connect" && <Connect onDone={() => setRoute("home")} />}
            {route === "connections" && <Connections onBack={() => setRoute("home")} />}
            {route === "history" && <TransactionHistory onBack={() => setRoute("home")} />}
            {route === "reveal" && <RevealPhrase onBack={() => setRoute("home")} />}
            {showDeployBar && <DeployStatusBar onOpen={() => setRoute("deploy")} />}
        </div>
    );
}

export default function App() {
    const [ready, setReady] = useState(false);
    const [initError, setInitError] = useState<string | null>(null);

    useEffect(() => {
        // A rejected init() (e.g. "Extension context invalidated" after an
        // update, or a corrupt vault read) must NOT leave the user on an
        // infinite spinner (LIFECYCLE-34). Surface an actionable reload — never
        // suggest resetting the wallet, which would imply data loss.
        vaultStore
            .init()
            .then(() => setReady(true))
            .catch((err) => {
                setInitError(describeError(err));
                setReady(true);
            });
    }, []);

    if (initError) {
        return (
            <div className="app">
                <div className="content">
                    <div className="card" style={{ borderColor: "var(--danger)" }}>
                        <div style={{ fontWeight: 600, marginBottom: 6 }}>Couldn't start the wallet</div>
                        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 10 }}>
                            {initError}
                        </div>
                        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 10 }}>
                            Your wallet data is safe. Reloading the extension usually fixes this.
                        </div>
                        <button
                            className="btn btn-primary btn-block"
                            onClick={() => (globalThis as any).chrome?.runtime?.reload?.()}
                        >
                            Reload extension
                        </button>
                    </div>
                </div>
            </div>
        );
    }

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
