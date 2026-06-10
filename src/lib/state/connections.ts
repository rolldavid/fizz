/**
 * Connected sites — origins the user has authorized to hand token-launch
 * drafts to the wallet. Today fizzwallet.com/launch is the only caller.
 *
 * ADDRESS-BLIND BY DESIGN. A connection records only the origin + timestamps.
 * The page learns "connected / not connected" and nothing more — never the
 * user's address, account, or keys. Every deploy is still reviewed and
 * confirmed in-wallet, from whatever account is active at confirm time, so the
 * connection grants no spending authority: it is purely a UI gate + an
 * anti-spam token (an un-connected origin can't even open a launch window).
 *
 * PERSISTENT + REVOCABLE. Stored in chrome.storage.local so a connection
 * survives browser restarts; capped by CONNECTION_TTL_MS; and removable from
 * the page (Disconnect) or in-wallet (Connected sites).
 */

export type Connection = {
    origin: string;
    approvedAt: number;
    expiresAt: number;
};

const CONNECTIONS_KEY = "fizz.connections.v1";
/** A connection lasts 30 days, then the site must re-request approval. */
export const CONNECTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function localArea(): { get: Function; set: Function; remove: Function } | null {
    return (globalThis as any).chrome?.storage?.local ?? null;
}
function sessionArea(): { get: Function; set: Function; remove: Function } | null {
    return (globalThis as any).chrome?.storage?.session ?? null;
}

async function readAll(): Promise<Connection[]> {
    const area = localArea();
    if (!area) return [];
    const got = await area.get(CONNECTIONS_KEY);
    const list = got?.[CONNECTIONS_KEY];
    return Array.isArray(list) ? (list as Connection[]) : [];
}

async function writeAll(list: Connection[]): Promise<void> {
    await localArea()?.set({ [CONNECTIONS_KEY]: list });
}

/** Live connections only — expired entries are pruned on read. */
export async function listConnections(): Promise<Connection[]> {
    const now = Date.now();
    const all = await readAll();
    const live = all.filter((c) => c.expiresAt > now);
    if (live.length !== all.length) await writeAll(live);
    return live;
}

export async function isConnected(origin: string): Promise<boolean> {
    const now = Date.now();
    const all = await readAll();
    return all.some((c) => c.origin === origin && c.expiresAt > now);
}

/** Approve (or refresh) a connection for an origin. */
export async function saveConnection(origin: string): Promise<Connection> {
    const now = Date.now();
    const conn: Connection = { origin, approvedAt: now, expiresAt: now + CONNECTION_TTL_MS };
    const others = (await readAll()).filter((c) => c.origin !== origin);
    await writeAll([...others, conn]);
    return conn;
}

export async function removeConnection(origin: string): Promise<void> {
    const others = (await readAll()).filter((c) => c.origin !== origin);
    await writeAll(others);
}

// ── Pending connect request (background → Connect screen hand-off) ───────────
// fizz:connect writes the requesting origin here and opens the wallet's
// #connect window; the Connect page reads it to show who's asking. Ephemeral
// (storage.session) and short-lived — an abandoned request shouldn't linger
// and silently pre-authorize a later, unrelated approval click.

export type PendingConnect = { origin: string; requestedAt: number };

const PENDING_KEY = "fizz.pendingConnect.v1";
const PENDING_TTL_MS = 5 * 60_000;

export async function savePendingConnect(origin: string): Promise<void> {
    await sessionArea()?.set({ [PENDING_KEY]: { origin, requestedAt: Date.now() } });
}

/** Read-and-clear the pending request. Returns null if absent or expired. */
export async function takePendingConnect(): Promise<PendingConnect | null> {
    const area = sessionArea();
    if (!area) return null;
    const got = await area.get(PENDING_KEY);
    const stored = (got?.[PENDING_KEY] as PendingConnect | undefined) ?? null;
    if (stored) await area.remove(PENDING_KEY);
    if (!stored) return null;
    if (Date.now() - stored.requestedAt > PENDING_TTL_MS) return null;
    return stored;
}
