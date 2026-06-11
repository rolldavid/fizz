/**
 * Plaintext relay slots for the auto-send bridge handshake (storage.session).
 *
 * Only PUBLIC values pass through here: the recipient (the connected account's
 * address — the deposit lands there), the claim secret HASH (written on-chain
 * by the deposit anyway), and the L1 tx hash. The claim SECRET stays in the
 * wallet's encrypted pending-bridge store and never touches these slots.
 *
 *   prepare — background records which origin asked to bridge; the popup reads it.
 *   params  — popup writes {recipient, secretHash} after the user approves; the
 *             web polls it (via fizz:bridge-params) to do the L1 deposit.
 *   deposit — web reports {secretHash, l1TxHash}; the popup reads it, marks the
 *             record "sent", and the existing recovery path completes the claim.
 *
 * prepare/params are ephemeral (storage.session, wiped on browser restart) and
 * short-lived (TTL) — an abandoned handshake shouldn't linger. The DEPOSIT slot
 * is different: it's the only copy of "your money moved on L1" until the wallet
 * adopts it, so it lives in storage.local with a long TTL and survives browser
 * restarts. It carries only public values (tx hash + secret HASH).
 */

export type BridgePrepare = { origin: string; amount: string; at: number };
export type BridgeParams = { recipient: string; secretHash: string; at: number };
export type BridgeDeposit = { secretHash: string; l1TxHash: string; at: number };

const PREPARE_KEY = "fizz.bridge.prepare.v1";
const PARAMS_KEY = "fizz.bridge.params.v1";
const DEPOSIT_KEY = "fizz.bridge.deposit.v1";
const TTL_MS = 10 * 60_000;
/** A deposit report must outlive restarts; the wallet may not open for days. */
const DEPOSIT_TTL_MS = 30 * 24 * 60 * 60_000;

function area(): { get: Function; set: Function; remove: Function } | null {
    return (globalThis as any).chrome?.storage?.session ?? null;
}
function localArea(): { get: Function; set: Function; remove: Function } | null {
    return (globalThis as any).chrome?.storage?.local ?? null;
}

async function readFrom<T extends { at: number }>(
    a: { get: Function } | null,
    key: string,
    ttl: number,
): Promise<T | null> {
    if (!a) return null;
    const got = await a.get(key);
    const v = (got?.[key] as T | undefined) ?? null;
    if (!v) return null;
    if (typeof v.at === "number" && Date.now() - v.at > ttl) return null;
    return v;
}

async function read<T extends { at: number }>(key: string): Promise<T | null> {
    return readFrom<T>(area(), key, TTL_MS);
}
async function write(key: string, value: object): Promise<void> {
    await area()?.set({ [key]: value });
}
async function drop(key: string): Promise<void> {
    await area()?.remove(key);
}

export const savePrepare = (origin: string, amount: string) =>
    write(PREPARE_KEY, { origin, amount, at: Date.now() });
export const readPrepare = () => read<BridgePrepare>(PREPARE_KEY);
export const clearPrepare = () => drop(PREPARE_KEY);

export const saveBridgeParams = (recipient: string, secretHash: string) =>
    write(PARAMS_KEY, { recipient, secretHash, at: Date.now() });
export const readBridgeParams = () => read<BridgeParams>(PARAMS_KEY);
export const clearBridgeParams = () => drop(PARAMS_KEY);

export const saveBridgeDeposit = async (secretHash: string, l1TxHash: string) => {
    await localArea()?.set({ [DEPOSIT_KEY]: { secretHash, l1TxHash, at: Date.now() } });
};
export const readBridgeDeposit = async (): Promise<BridgeDeposit | null> => {
    const local = await readFrom<BridgeDeposit>(localArea(), DEPOSIT_KEY, DEPOSIT_TTL_MS);
    if (local) return local;
    // Migration: a report written by an older build still sits in session.
    return readFrom<BridgeDeposit>(area(), DEPOSIT_KEY, TTL_MS);
};
export const clearBridgeDeposit = async () => {
    await localArea()?.remove(DEPOSIT_KEY);
    await drop(DEPOSIT_KEY);
};
