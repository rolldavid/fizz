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

export async function saveDeployDraft(draft: DeployDraft): Promise<void> {
    await sessionArea()?.set({ [DRAFT_KEY]: draft });
}

export async function takeDeployDraft(): Promise<DeployDraft | null> {
    const area = sessionArea();
    if (!area) return null;
    const got = await area.get(DRAFT_KEY);
    const draft = (got?.[DRAFT_KEY] as DeployDraft) ?? null;
    if (draft) await area.remove(DRAFT_KEY);
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

// ── Connect (fizzwallet.com/bridge → wallet address grant) ──────────────────
// /bridge deposits ONLY into the connected Fizz account, so the page asks for
// the active address. The background can't know it (vault-locked), so it
// opens the #connect approval window; the user decides there. Session-scoped:
// grants die with the browser. Only ever served to our own origins.

export type ConnectRequest = { origin: string; at: number };
export type ConnectGrant = {
    origin: string;
    /** Set when approved. */
    address?: string;
    networkId?: string;
    denied?: boolean;
    at: number;
};

const CONNECT_REQUEST_KEY = "fizz.connectRequest.v1";
const CONNECT_GRANT_KEY = "fizz.connectGrant.v1";

export async function recordConnectRequest(req: ConnectRequest): Promise<void> {
    const area = sessionArea();
    if (!area) throw new Error("storage.session unavailable.");
    // A new request supersedes any previous grant — the page is asking fresh.
    await area.remove(CONNECT_GRANT_KEY);
    await area.set({ [CONNECT_REQUEST_KEY]: req });
}

export async function readConnectRequest(): Promise<ConnectRequest | null> {
    const area = sessionArea();
    if (!area) return null;
    const got = await area.get(CONNECT_REQUEST_KEY);
    return (got?.[CONNECT_REQUEST_KEY] as ConnectRequest) ?? null;
}

export async function recordConnectGrant(grant: ConnectGrant): Promise<void> {
    const area = sessionArea();
    if (!area) throw new Error("storage.session unavailable.");
    await area.remove(CONNECT_REQUEST_KEY);
    await area.set({ [CONNECT_GRANT_KEY]: grant });
}

export async function readConnectGrant(): Promise<ConnectGrant | null> {
    const area = sessionArea();
    if (!area) return null;
    const got = await area.get(CONNECT_GRANT_KEY);
    return (got?.[CONNECT_GRANT_KEY] as ConnectGrant) ?? null;
}
