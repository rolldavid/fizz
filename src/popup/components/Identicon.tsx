/**
 * Tiny deterministic identicon derived from an address.
 *
 * Not cryptographic — purely visual. Gives every address a recognisable shape
 * so users have a second channel for verifying they're sharing the right one.
 */

import { useMemo } from "react";

function hash(input: string): number {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function pickColor(seed: number, offset = 0): string {
    const h = (seed * 31 + offset * 17) % 360;
    return `hsl(${h}deg 70% 55%)`;
}

export function Identicon({ address, size = 36 }: { address: string; size?: number }) {
    const seed = useMemo(() => hash(address || "0"), [address]);
    const c1 = pickColor(seed, 0);
    const c2 = pickColor(seed, 7);

    // 5x5 grid with horizontal mirror; toggle each cell based on a bit of the seed.
    const cells: boolean[] = [];
    for (let i = 0; i < 15; i++) cells.push(((seed >> i) & 1) === 1);

    const grid: boolean[][] = [];
    for (let r = 0; r < 5; r++) {
        const row: boolean[] = [];
        for (let c = 0; c < 5; c++) {
            const mc = c < 3 ? c : 4 - c;
            row.push(cells[r * 3 + mc]);
        }
        grid.push(row);
    }

    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 5 5"
            style={{
                borderRadius: "50%",
                background: `linear-gradient(135deg, ${c1}, ${c2})`,
                padding: 2,
                boxSizing: "border-box",
            }}
            aria-hidden="true"
        >
            {grid.map((row, r) =>
                row.map((on, c) =>
                    on ? (
                        <rect
                            key={`${r}-${c}`}
                            x={c}
                            y={r}
                            width={1}
                            height={1}
                            fill="rgba(255,255,255,0.92)"
                        />
                    ) : null,
                ),
            )}
        </svg>
    );
}
