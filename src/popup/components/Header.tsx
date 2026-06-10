import { useWallet } from "../../lib/state/walletContext";
import type { AztecNetwork } from "../../lib/aztec/networks";

export function Header({ right }: { right?: React.ReactNode }) {
    const { network, networks, setNetwork } = useWallet();

    return (
        <div className="header">
            <div className="brand">
                <img src="/fizz_plain.svg" alt="Fizz" className="brand-logo-header" />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <select
                    value={network.id}
                    onChange={(e) => void setNetwork(e.target.value as AztecNetwork["id"])}
                    style={{
                        // backgroundColor (not the `background` shorthand) so the
                        // global select's custom chevron background-image survives.
                        backgroundColor: "var(--surface-2)",
                        color: "var(--text-dim)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-sm)",
                        padding: "5px 26px 5px 10px",
                        fontSize: 11,
                        width: "auto",
                    }}
                >
                    {networks.map((n) => (
                        <option key={n.id} value={n.id}>
                            {n.name}
                        </option>
                    ))}
                </select>
                {right}
            </div>
        </div>
    );
}

export function shortAddress(addr: string, head = 6, tail = 4): string {
    if (addr.length <= head + tail + 3) return addr;
    return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
