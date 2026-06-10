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

export async function saveDeployDraft(draft: DeployDraft): Promise<void> {
    await sessionArea()?.set({ [DRAFT_KEY]: { ...draft, savedAt: Date.now() } });
}

export async function takeDeployDraft(): Promise<DeployDraft | null> {
    const area = sessionArea();
    if (!area) return null;
    const got = await area.get(DRAFT_KEY);
    const stored = (got?.[DRAFT_KEY] as (DeployDraft & { savedAt?: number }) | undefined) ?? null;
    if (stored) await area.remove(DRAFT_KEY);
    if (!stored) return null;
    if (typeof stored.savedAt === "number" && Date.now() - stored.savedAt > DRAFT_TTL_MS) {
        return null; // expired — don't pre-fill
    }
    const { savedAt: _omit, ...draft } = stored;
    return draft;
}

// ── Launch result (extension → fizzwallet.com/launch round-trip) ────────────
// /launch hands a draft to the wallet and then polls for the outcome. The
// Deploy page records its success here; the background worker serves it to
// the page. Public on-chain data only (token address + tx hash).

export type LastLaunch = {
    address: string;
    txHash: string;
    name: string;
    symbol: string;
    at: number;
};

const LAUNCH_RESULT_KEY = "fizz.lastLaunch.v1";

export async function recordLastLaunch(result: LastLaunch): Promise<void> {
    await sessionArea()?.set({ [LAUNCH_RESULT_KEY]: result });
}

export async function readLastLaunch(): Promise<LastLaunch | null> {
    const area = sessionArea();
    if (!area) return null;
    const got = await area.get(LAUNCH_RESULT_KEY);
    return (got?.[LAUNCH_RESULT_KEY] as LastLaunch) ?? null;
}
