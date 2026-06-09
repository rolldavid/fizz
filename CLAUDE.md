# Aztec Project

## Critical: Use `aztec` CLI, not `nargo` directly

This is an Aztec smart contract project. Always use the `aztec` CLI wrapper instead of calling `nargo` directly:

- **Compile**: `aztec compile` (NOT `nargo compile`). Using `nargo compile` alone produces incomplete artifacts.
- **Test**: `aztec test` (NOT `nargo test`).
- **Other nargo commands** like `aztec-nargo fmt` and `aztec-nargo doc` are fine to use directly. The Aztec installer exposes the bundled `nargo` as `aztec-nargo`; bare `nargo` resolves to your own install (if any), not the bundled one.

## Error Handling

- NEVER silently swallow errors or fall back to default values. If a value is required, throw if it's missing.
- NEVER use fallback values like `AztecAddress.ZERO`, `"unknown"`, `0`, or `null` to mask missing data. These hide bugs and cause failures elsewhere that are harder to trace.
- NEVER add retry/polling logic unless explicitly asked. Retry loops with long timeouts may brick application loops and mask the real error.
- NEVER wrap calls in try/catch that returns null or a default. Let errors propagate.
- If a precondition isn't met, throw immediately with a descriptive message — don't try to "work around" it.
- Prefer `T` return types over `T | null` when null would indicate a bug rather than a valid state.
- Do not add `.catch(() => defaultValue)` to promises. If something fails, the caller needs to know.

## Hashing: Default to Poseidon2

When writing Aztec.nr contract code that requires hashing, **always use Poseidon2** unless a specific protocol or interoperability requirement calls for a different hash.

- **Default**: `use aztec::protocol::hash::poseidon2_hash;`
- **Do NOT** default to Pedersen (`pedersen_hash`). Pedersen is available but Poseidon2 is cheaper in circuits and is the standard across Aztec.
- If you are unsure which hash to use, use Poseidon2.

## Reference repos (read-only, for understanding Aztec internals)

- `../priv_ideas/aztec-packages` — full Aztec monorepo (PXE, wallet-sdk, aztec.js, noir-contracts)
- `../priv_ideas/aztec-nr` — Aztec.nr standard library
- `../priv_ideas/barretenberg` — proving backend / cryptography

When in doubt about an API or pattern, search those repos first.

## Stack

- **Framework**: Vite + React + TypeScript (do NOT use Next.js)
- **Target**: Chrome MV3 browser extension (Chromium-only for v1)
- **PXE**: runs in-browser inside the extension (not a remote service)
- **No webapp / Railway deploy** — distribution is the extension itself

## MCP servers

This repo's `.mcp.json` provides the Aztec and Noir MCP servers. If you need to register them at a different scope, install with:

```sh
claude mcp add aztec -- npx @aztec/mcp-server@latest
claude mcp add noir -- npx noir-mcp-server@latest
```
