/**
 * Passphrase strength policy for the password unlock path.
 *
 * The vault ciphertext lives on disk (chrome.storage.local) and is therefore
 * offline-bruteforceable, so for the password path the passphrase is the only
 * thing standing between an attacker and the mnemonic — even with Argon2id, a
 * weak passphrase loses. We require real length + variety (or a long passphrase)
 * and reject obvious weak/common patterns. This is a deliberately dependency-free
 * heuristic (no zxcvbn bundle bloat) that blocks the realistic weak cases.
 *
 * Single source of truth: the onboarding UI uses `passwordStrength` for the live
 * meter, and the vault enforces `isAcceptablePassphrase` at creation so the bar
 * can't be bypassed.
 */

export const MIN_PASSPHRASE_LENGTH = 12;

// Lowercased substrings that, if present, mark a passphrase as weak regardless
// of length/variety. Small on purpose — catches the obvious cases.
const COMMON_SUBSTRINGS = [
    "password",
    "passphrase",
    "passw0rd",
    "12345",
    "qwerty",
    "asdfgh",
    "letmein",
    "iloveyou",
    "welcome",
    "admin",
    "monkey",
    "dragon",
    "abc123",
    "aztec",
    "wallet",
    "secret",
    "0000",
    "1111",
];

export type PassStrength = {
    /** 0 = empty, 1 = unacceptable, 2 = fair, 3 = good, 4 = strong. */
    score: 0 | 1 | 2 | 3 | 4;
    label: string;
    hint?: string;
    /** True iff the passphrase clears the minimum bar (score >= 2). */
    ok: boolean;
};

export function passwordStrength(pw: string): PassStrength {
    if (!pw) return { score: 0, label: "", ok: false };

    const lower = /[a-z]/.test(pw);
    const upper = /[A-Z]/.test(pw);
    const digit = /[0-9]/.test(pw);
    const symbol = /[^a-zA-Z0-9]/.test(pw);
    const classes = [lower, upper, digit, symbol].filter(Boolean).length;
    const unique = new Set(pw).size;
    const lc = pw.toLowerCase();

    const weak =
        unique <= 3 || // "aaaaaaaaaaaa", "abababab"
        /^(.)\1+$/.test(pw) || // all one character
        /(0123456|1234567|abcdefg|qwertyui)/.test(lc) || // sequences
        COMMON_SUBSTRINGS.some((c) => lc.includes(c));

    if (pw.length < MIN_PASSPHRASE_LENGTH) {
        return {
            score: 1,
            label: "Too short",
            hint: `use at least ${MIN_PASSPHRASE_LENGTH} characters`,
            ok: false,
        };
    }
    if (weak) {
        return {
            score: 1,
            label: "Weak",
            hint: "avoid common words, repeats and sequences",
            ok: false,
        };
    }
    // Minimum acceptable bar: 3+ character types, OR a long (16+) passphrase
    // (so diceware-style word passphrases pass via length).
    if (classes < 3 && pw.length < 16) {
        return {
            score: 1,
            label: "Weak",
            hint: "add another character type, or make it 16+ characters",
            ok: false,
        };
    }

    let score: 2 | 3 | 4 = 2;
    if (pw.length >= 16 || classes >= 4) score = 3;
    if ((pw.length >= 16 && classes >= 3) || pw.length >= 24) score = 4;
    return {
        score,
        label: score === 4 ? "Strong" : score === 3 ? "Good" : "Fair",
        ok: true,
    };
}

export function isAcceptablePassphrase(pw: string): boolean {
    return passwordStrength(pw).ok;
}
