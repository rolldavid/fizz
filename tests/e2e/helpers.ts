/**
 * E2E helpers for tests against `aztec start --local-network`.
 */

export const SANDBOX_NODE_URL = "http://localhost:8080";
export const ANVIL_URL = "http://localhost:8545";

export async function assertSandboxUp(): Promise<void> {
    let info: any;
    try {
        const res = await fetch(SANDBOX_NODE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "node_getNodeInfo", params: [], id: 1 }),
        });
        info = await res.json();
    } catch (err) {
        throw new Error(
            `Local Aztec network is not reachable at ${SANDBOX_NODE_URL}. ` +
                `Start it with \`aztec start --local-network\` before running e2e tests. (${err})`,
        );
    }
    if (!info?.result?.nodeVersion) {
        throw new Error(`Node at ${SANDBOX_NODE_URL} returned unexpected info: ${JSON.stringify(info)}`);
    }
}

/**
 * Minimal EIP-1193 provider over anvil's JSON-RPC. Anvil's default accounts
 * are unlocked, so eth_sendTransaction works server-side — exactly what the
 * in-extension flow gets from MetaMask, without a browser.
 */
export function anvilProvider(url: string = ANVIL_URL) {
    let id = 0;
    async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        const body: any = await res.json();
        if (body.error) {
            throw new Error(`anvil ${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
        }
        return body.result;
    }
    return {
        async request({ method, params = [] }: { method: string; params?: unknown[] }) {
            if (method === "eth_requestAccounts") return rpc("eth_accounts", []);
            return rpc(method, params);
        },
    };
}

/**
 * EIP-1193 provider that signs LOCALLY with a private key and talks to a public
 * Sepolia RPC — what the in-extension flow gets from MetaMask, minus the UI.
 * Only used by env-gated testnet tests; the key comes from the environment and
 * is never persisted or logged.
 */
export async function sepoliaKeyProvider(privateKeyHex: string, rpcUrl: string) {
    const { privateKeyToAccount } = await import("viem/accounts");
    const { createWalletClient, createPublicClient, http } = await import("viem");
    const { sepolia } = await import("viem/chains");
    const account = privateKeyToAccount(
        (privateKeyHex.startsWith("0x") ? privateKeyHex : `0x${privateKeyHex}`) as `0x${string}`,
    );
    const walletClient = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });
    const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
    return {
        address: account.address,
        async request({ method, params = [] }: { method: string; params?: unknown[] }) {
            if (method === "eth_requestAccounts" || method === "eth_accounts") {
                return [account.address];
            }
            if (method === "eth_sendTransaction") {
                const tx = (params as any[])[0] ?? {};
                const hash = await walletClient.sendTransaction({
                    to: tx.to,
                    data: tx.data,
                    value: tx.value ? BigInt(tx.value) : undefined,
                    gas: tx.gas ? BigInt(tx.gas) : undefined,
                });
                return hash;
            }
            return publicClient.request({ method: method as any, params: params as any });
        },
    };
}

/** Poll until `fn` returns a truthy value. Throws with `label` on timeout. */
export async function waitFor<T>(
    fn: () => Promise<T | undefined | false>,
    opts: { label: string; timeoutMs?: number; intervalMs?: number },
): Promise<T> {
    // Sandbox L2 slots are ~72s and assertions often need the NEXT block after
    // a tx, so chain-settling waits get a generous default.
    const timeoutMs = opts.timeoutMs ?? 240_000;
    const intervalMs = opts.intervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    for (;;) {
        try {
            const out = await fn();
            if (out) return out as T;
            lastErr = undefined;
        } catch (err) {
            lastErr = err;
        }
        if (Date.now() > deadline) {
            throw new Error(
                `Timed out after ${timeoutMs}ms waiting for: ${opts.label}` +
                    (lastErr ? ` (last error: ${lastErr})` : ""),
            );
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}
