# Fizz web app — fizzwallet.com/bridge + /launch

Vite + React + TypeScript multi-page app with two entries:

- **`/bridge`** — bridge fee juice (Aztec gas) from L1 Sepolia into the
  **connected Fizz wallet** using the user's own Ethereum wallet (RainbowKit +
  wagmi + viem). The recipient is connect-only: the page asks the extension
  for the active account via `fizz:connect` / `fizz:connect-status` (no manual
  address entry — without the extension the flow is disabled). Produces a
  **claim ticket** the Fizz extension imports (auto via
  `chrome.runtime.sendMessage`, or copy-paste).
- **`/launch`** — token launcher that hands a draft to the Fizz extension.
  Ships **zero** wallet/L1 code (no wagmi/RainbowKit in its chunks — the build
  script verifies this).

## Develop

```sh
cd web
yarn install
yarn dev          # vite dev server; pages at /webassets/bridge/ and /webassets/launch/
```

The extension's `externally_connectable` allows `http://localhost/*`, so the
extension hand-off works in dev too.

## Build (output is COMMITTED into ../landing)

```sh
cd web
yarn build
```

`yarn build` = `tsc` → `vite build` → `scripts/deploy-to-landing.mjs`, which
copies the output into the **static, no-build** Netlify site:

```
landing/bridge/index.html      ← built page
landing/launch/index.html      ← built page
landing/webassets/…            ← all hashed js/css + favicon (shared /webassets/ base)
```

Netlify serves `landing/` with an empty build command (see /netlify.toml — do
not change it), so these generated files must be **committed**. The deploy
script sanity-checks titles, that every referenced `/webassets/` URL exists,
and that `/launch` ships no wallet code; it exits non-zero on any failure.

## WalletConnect project id (site owner TODO)

`src/config.ts` reads `VITE_WALLETCONNECT_PROJECT_ID` and falls back to the
placeholder `"FIZZ_WC_PROJECT_ID"`. Injected wallets (MetaMask, Rabby, …) work
with the placeholder; the WalletConnect QR option does not. Create a free
project at <https://cloud.walletconnect.com> and rebuild with:

```sh
VITE_WALLETCONNECT_PROJECT_ID=<your-id> yarn build
```

## Extension id

`src/config.ts` exports `EXTENSION_ID` — the single place the Fizz extension
id lives. If the published Chrome Web Store id ever differs from the current
dev id, update it there and rebuild.

## ⚠️ Keep in sync: claimTicket.ts

`src/claimTicket.ts` is a **verbatim copy** of the extension's
`/src/lib/aztec/claimTicket.ts` (web/ is a standalone package; importing
across the repo would drag the extension's build setup in). If the ticket
format ever changes, change **both** files together — the extension decodes
exactly what this page encodes.

## Claim-secret correctness & the big lazy chunk

The bridge page imports `generateClaimSecret` from `@aztec/aztec.js@4.3.0`
(same pinned version as the extension) so the secret **hash** is computed by
the exact protocol code — never re-implemented. That graph includes bb.js's
poseidon2 WASM (a ~3.5 MB base64 data-url chunk); it is **lazily imported**
only when a bridge flow starts, so initial page load stays light. bb.js's
*threaded* WASM twin is aliased away in `vite.config.ts` (the page is never
cross-origin isolated, and the sync poseidon path always uses 1 thread) to
keep a dead 3.5 MB chunk out of the repo.

## House rules baked in

- Fee juice only, one-way L1→L2 only (protocol facts, stated in the UI).
- Canonical L1 addresses are fetched **live** from
  `https://rpc.testnet.aztec-labs.com` (`node_getNodeInfo`) — never hardcoded.
- The claim secret is generated client-side and persisted to `localStorage`
  **before** any L1 transaction (fund safety).
- No analytics, no external fonts/CDNs, errors surfaced verbatim with a retry.
