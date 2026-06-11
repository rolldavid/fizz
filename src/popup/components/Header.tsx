import { useEffect, useRef, useState } from "react";
import { useWallet } from "../../lib/state/walletContext";

/**
 * App-styled network picker. A native <select> here always opened an
 * OS-rendered option list that clashed with the design system, so this is a
 * pill + .menu-dropdown like every other menu in the app.
 */
function NetworkSelect() {
    const { network, networks, setNetwork } = useWallet();
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDoc);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDoc);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    return (
        <div className="header-menu" ref={ref}>
            <button
                className="network-pill"
                onClick={() => setOpen((o) => !o)}
                title="Switch network"
                aria-label="Switch network"
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                {network.name}
                <span className="network-pill-chevron" aria-hidden>
                    ▾
                </span>
            </button>
            {open && (
                <div className="menu-dropdown" role="listbox" aria-label="Networks">
                    {networks.map((n) => (
                        <button
                            key={n.id}
                            className="menu-item"
                            role="option"
                            aria-selected={n.id === network.id}
                            onClick={() => {
                                setOpen(false);
                                if (n.id !== network.id) void setNetwork(n.id);
                            }}
                        >
                            <span style={{ flex: 1 }}>{n.name}</span>
                            {n.id === network.id && (
                                <span style={{ color: "var(--success)" }}>✓</span>
                            )}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function Header({ right }: { right?: React.ReactNode }) {
    return (
        <div className="header">
            <div className="brand">
                <img src="/fizz_plain.svg" alt="Fizz" className="brand-logo-header" />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <NetworkSelect />
                {right}
            </div>
        </div>
    );
}

export function shortAddress(addr: string, head = 6, tail = 4): string {
    if (addr.length <= head + tail + 3) return addr;
    return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
