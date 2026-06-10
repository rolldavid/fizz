import { useEffect, useState } from "react";
import { Header, shortAddress } from "../components/Header";
import { Identicon } from "../components/Identicon";
import { useWallet } from "../../lib/state/walletContext";
import {
    readConnectRequest,
    recordConnectGrant,
    type ConnectRequest,
} from "../../lib/state/opJournal";

/**
 * Connection approval — opened by the background worker when
 * fizzwallet.com/bridge asks to see the active account address (the bridge
 * deposits ONLY into the connected wallet; there is no manual recipient).
 * Approving shares exactly one thing with that page: address + network id.
 */
export function ConnectApprove() {
    const { account, network } = useWallet();
    const [request, setRequest] = useState<ConnectRequest | null>(null);
    const [missing, setMissing] = useState(false);
    const [decided, setDecided] = useState<"approved" | "denied" | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void readConnectRequest().then((r) => (r ? setRequest(r) : setMissing(true)));
    }, []);

    async function decide(approve: boolean) {
        if (!request) return;
        setError(null);
        try {
            if (approve) {
                if (!account) throw new Error("No account loaded.");
                await recordConnectGrant({
                    origin: request.origin,
                    address: account.address.toString(),
                    networkId: network.id,
                    at: Date.now(),
                });
                setDecided("approved");
            } else {
                await recordConnectGrant({ origin: request.origin, denied: true, at: Date.now() });
                setDecided("denied");
            }
            setTimeout(() => window.close(), 1500);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }

    return (
        <>
            <Header />
            <div className="content">
                <div style={{ fontWeight: 600, fontSize: 16 }}>Connect to a Fizz page?</div>

                {missing && (
                    <div className="card">
                        <div className="hint">
                            No pending connection request — open fizzwallet.com/bridge and click
                            “Connect Fizz wallet”, then this window appears by itself.
                        </div>
                    </div>
                )}

                {request && !decided && account && (
                    <>
                        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
                                {request.origin}
                            </div>
                            <div className="hint" style={{ margin: 0 }}>
                                wants to see your account address so bridged fee juice lands in
                                this wallet. Nothing else is shared — no keys, no balances, no
                                history.
                            </div>
                        </div>
                        <div className="card" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <Identicon address={account.address.toString()} size={32} />
                            <div>
                                <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                                    {shortAddress(account.address.toString(), 10, 8)}
                                </div>
                                <div className="muted" style={{ fontSize: 11 }}>{network.name}</div>
                            </div>
                        </div>
                        <button className="btn btn-primary btn-block" onClick={() => decide(true)}>
                            Connect this account
                        </button>
                        <button className="btn btn-ghost btn-block" onClick={() => decide(false)}>
                            Deny
                        </button>
                        <div className="hint" style={{ fontSize: 11 }}>
                            The connection lasts until you close your browser. Wrong account?
                            Switch accounts on Home first, then reconnect from the page.
                        </div>
                    </>
                )}

                {decided && (
                    <div className="card" style={{ borderColor: decided === "approved" ? "var(--success)" : "var(--border)" }}>
                        <div style={{ fontWeight: 500 }}>
                            {decided === "approved" ? "✓ Connected" : "Denied"}
                        </div>
                        <div className="hint" style={{ marginTop: 4 }}>
                            You can close this window — the page picks it up automatically.
                        </div>
                    </div>
                )}

                {error && <div className="error">{error}</div>}
            </div>
        </>
    );
}
