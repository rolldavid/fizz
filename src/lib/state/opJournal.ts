/**
 * Crash journal for the token deploy — the one multi-minute operation a user
 * is most likely to lose to the toolbar popup closing on blur.
 *
 * The deploy's contract address is DETERMINISTIC and known before the tx is
 * sent (DeployMethod caches its instance), so we journal it pre-send. If the
 * popup dies mid-deploy, the next session probes the chain for that address:
 * found → the deploy actually landed and we recover it into the token list;
 * absent → we can tell the user exactly what happened instead of silence.
 *
 * Backed by chrome.storage.session: survives popup closes, intentionally
 * cleared on browser restart (a journal that old is stale either way).
 * Plaintext by design — it holds only public on-chain data (a contract
 * address + token metadata), never secrets.
 */

export type DeployJournal = {
    predictedAddress: string;
    name: string;
    symbol: string;
    decimals: number;
    networkId: string;
    /** Initial-supply mint is a SECOND tx; if we died after deploy it never ran. */
    hadInitialSupply: boolean;
    startedAt: number;
};

const KEY = "fizz.deployJournal.v1";

function sessionArea(): { get: Function; set: Function; remove: Function } | null {
    return (globalThis as any).chrome?.storage?.session ?? null;
}

export async function recordDeployStart(entry: DeployJournal): Promise<void> {
    await sessionArea()?.set({ [KEY]: entry });
}

export async function readDeployJournal(): Promise<DeployJournal | null> {
    const area = sessionArea();
    if (!area) return null;
    const got = await area.get(KEY);
    return (got?.[KEY] as DeployJournal) ?? null;
}

export async function clearDeployJournal(): Promise<void> {
    await sessionArea()?.remove(KEY);
}

// ── Deploy-form draft hand-off (popup → standalone window) ──────────────────
// When the user jumps from the fragile popup to a standalone window, carry
// their typed form along so they don't start over. One-shot: read clears it.

export type DeployDraft = {
    name: string;
    symbol: string;
    decimals: string;
    supply: string;
    supplyMode: "private" | "public";
    keepMinter: boolean;
};

const DRAFT_KEY = "fizz.deployDraft.v1";
/**
 * A draft is a UI convenience, never authority — the user reviews and confirms
 * every deploy in-wallet. The TTL just prevents a stale draft (e.g. a
 * launch-token hand-off that opened the Unlock screen and was abandoned) from
 * silently pre-filling a much later manual Deploy visit.
 */
const DRAFT_TTL_MS = 5 * 60_000;

export async function saveDeployDraft(draft: DeployDraft, origin?: string): Promise<void> {
    await sessionArea()?.set({ [DRAFT_KEY]: { ...draft, savedAt: Date.now(), origin: origin ?? null } });
}

/**
 * One-shot read of the draft plus the origin that handed it over (null for a
 * manual in-wallet visit). The origin lets the Deploy page report the public
 * result back ONLY to the site that initiated the launch — never to an
 * unrelated page, and never for a manual deploy.
 */
export async function takeDeployDraft(): Promise<{ draft: DeployDraft; origin: string | null } | null> {
    const area = sessionArea();
    if (!area) return null;
    const got = await area.get(DRAFT_KEY);
    const stored =
        (got?.[DRAFT_KEY] as (DeployDraft & { savedAt?: number; origin?: string | null }) | undefined) ?? null;
    if (stored) await area.remove(DRAFT_KEY);
    if (!stored) return null;
    if (typeof stored.savedAt === "number" && Date.now() - stored.savedAt > DRAFT_TTL_MS) {
        return null; // expired — don't pre-fill
    }
    const { savedAt: _omit, origin = null, ...draft } = stored;
    return { draft, origin };
}

// ── Launch result (extension → fizzwallet.com/launch round-trip) ────────────
// /launch hands a draft to the wallet and then polls for the outcome. The
// Deploy page records its success here ONLY when the deploy was launch-
// initiated (never for a manual in-wallet deploy), tagged with the initiating
// origin; the background worker serves it back ONLY to that same connected
// origin, within a short TTL. This keeps the otherwise address-blind browser
// session from being linked, by any fizzwallet.com page, to an on-chain
// deployment. Public on-chain data only (token address + tx hash).

export type LastLaunch = {
    address: string;
    txHash: string;
    name: string;
    symbol: string;
    at: number;
    /** The site that initiated this launch. The result is served ONLY to it. */
    origin: string;
};

const LAUNCH_RESULT_KEY = "fizz.lastLaunch.v1";
/** A launch result is public token data, but still origin-scoped + short-lived. */
const LAUNCH_RESULT_TTL_MS = 5 * 60_000;

export async function recordLastLaunch(result: LastLaunch): Promise<void> {
    await sessionArea()?.set({ [LAUNCH_RESULT_KEY]: result });
}

/**
 * Return the launch result ONLY to the origin that initiated it, and only
 * within the TTL. The background additionally gates this behind a live
 * connection, so an unrelated or never-connected page can never learn what (or
 * whether) the user deployed.
 */
export async function readLastLaunchFor(origin: string): Promise<Omit<LastLaunch, "origin"> | null> {
    const area = sessionArea();
    if (!area) return null;
    const got = await area.get(LAUNCH_RESULT_KEY);
    const stored = (got?.[LAUNCH_RESULT_KEY] as LastLaunch | undefined) ?? null;
    if (!stored || stored.origin !== origin) return null;
    if (Date.now() - stored.at > LAUNCH_RESULT_TTL_MS) {
        await area.remove(LAUNCH_RESULT_KEY);
        return null;
    }
    const { origin: _omit, ...pub } = stored;
    return pub;
}
