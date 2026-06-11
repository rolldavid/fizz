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
 *
 * (The deploy-draft hand-off and /launch result round-trip that used to live
 * here were removed with the fizzwallet.com/launch flow — token deployment is
 * fully in-wallet now: Deploy screen + deployTask.)
 */

export type DeployJournal = {
    predictedAddress: string;
    name: string;
    symbol: string;
    decimals: number;
    networkId: string;
    /** Account that deployed — token lists are per-account, so recovery must
     * credit the right one. Optional only for journals from older builds. */
    deployer?: string;
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
