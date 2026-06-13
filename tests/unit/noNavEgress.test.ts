import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * PRIVACY-30 — navigation-class egress (`window.open`, `location.href=`,
 * `location.assign/replace`) is NOT governed by the CSP connect-src, so a
 * popup that navigates can exfiltrate the in-memory seed past the egress
 * firewall. We forbid these in OUR source as a regression guard (the
 * malicious-dependency case is the documented residual; a `sandbox` CSP
 * directive is the deeper mitigation). window.close() is not egress and is
 * allowed.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const BANNED = [
    /\bwindow\.open\s*\(/,
    /\blocation\.href\s*=/,
    /\blocation\.assign\s*\(/,
    /\blocation\.replace\s*\(/,
    /\.location\s*=\s*["'`]/,
];

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
}

describe("no navigation-class egress in src (PRIVACY-30)", () => {
    it("contains no window.open / location assignment", () => {
        const offenders: string[] = [];
        for (const file of walk(SRC)) {
            const text = readFileSync(file, "utf8");
            for (const re of BANNED) {
                if (re.test(text)) offenders.push(`${file} :: ${re}`);
            }
        }
        expect(offenders, `navigation egress found:\n${offenders.join("\n")}`).toEqual([]);
    });
});
