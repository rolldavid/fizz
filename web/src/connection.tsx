/**
 * Fizz wallet connection, lifted to the app root so the nav button and the page
 * body share one source of truth. The "Connect Wallet" handshake lives in the
 * top nav now (not per-page).
 *
 * Address-blind: connecting tells the page only "connected / not" — never the
 * user's address, keys, or balances (see web/src/extension.ts).
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { detectPlatform, type Platform } from "./platform";
import { connectFizz, disconnectFizz, getConnectionStatus } from "./extension";

export type ConnStatus = "checking" | "absent" | "disconnected" | "connected";

type ConnectionValue = {
    platform: Platform;
    status: ConnStatus;
    connecting: boolean;
    note: string | null;
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
};

const ConnectionContext = createContext<ConnectionValue | null>(null);

export function useConnection(): ConnectionValue {
    const v = useContext(ConnectionContext);
    if (!v) throw new Error("useConnection must be used within <ConnectionProvider>");
    return v;
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
    const [platform] = useState(detectPlatform);
    const [status, setStatus] = useState<ConnStatus>(platform.canUseExtension ? "checking" : "absent");
    const [connecting, setConnecting] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const pollRef = useRef<number | null>(null);

    function stopPoll() {
        if (pollRef.current !== null) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }

    // Re-checked on mount and on focus — the user approves in the wallet's own
    // window, then tabs back here. Skipped where the extension can't run.
    useEffect(() => {
        if (!platform.canUseExtension) return;
        let cancelled = false;
        const refresh = () =>
            void getConnectionStatus().then((s) => {
                if (cancelled) return;
                setStatus(!s.installed ? "absent" : s.connected ? "connected" : "disconnected");
                if (s.connected) {
                    setConnecting(false);
                    stopPoll();
                }
            });
        refresh();
        window.addEventListener("focus", refresh);
        return () => {
            cancelled = true;
            window.removeEventListener("focus", refresh);
            stopPoll();
        };
    }, [platform]);

    async function connect() {
        setNote(null);
        try {
            await connectFizz();
        } catch (err) {
            setNote(err instanceof Error ? err.message : String(err));
            return;
        }
        // Approval happens in the wallet's window; poll until it lands.
        setConnecting(true);
        stopPoll();
        let waited = 0;
        pollRef.current = window.setInterval(() => {
            void getConnectionStatus().then((s) => {
                waited += 2;
                if (s.connected) {
                    setStatus("connected");
                    setConnecting(false);
                    stopPoll();
                } else if (waited >= 120) {
                    setConnecting(false);
                    stopPoll();
                    setNote("Still waiting — approve the connection in the Fizz window.");
                }
            });
        }, 2000);
    }

    async function disconnect() {
        setNote(null);
        try {
            await disconnectFizz();
            setStatus("disconnected");
        } catch (err) {
            setNote(err instanceof Error ? err.message : String(err));
        }
    }

    return (
        <ConnectionContext.Provider value={{ platform, status, connecting, note, connect, disconnect }}>
            {children}
        </ConnectionContext.Provider>
    );
}
