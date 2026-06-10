# Fizz web app — fizzwallet.com

A single-page Vite + React + TypeScript app: the home page, **`/bridge`**, and
**`/launch`**, all served from one bundle with client-side routing.

- **`/bridge`** — bridge fee juice (Aztec gas) from Ethereum **mainnet** into the
  **connected Fizz wallet**. The user connects an Ethereum wallet — **MetaMask or
  Rabby only** (injected / EIP-6963, via wagmi; **no WalletConnect**). The Fizz
  extension generates the claim secret and auto-completes the claim, so there's
  nothing to copy. The page never learns the user's Aztec address.
- **`/launch`** — hands a token draft to the Fizz extension, which proves and
  deploys it locally. The page never sees the user's address or keys.

Both wallet connections live in the top nav and are **site-wide**: connect once,
and the state persists across routes. The Aztec (Fizz) connection is
address-blind; the Ethereum connection does not auto-reconnect (the address only
enters the page after an explicit connect).

## Develop

```sh
cd web
yarn install
yarn dev          # vite dev server at / (home), /bridge, /launch
```

The extension's `externally_connectable` allows `http://localhost/*`, so the
extension hand-off works in dev too.

## Build

```sh
yarn build        # tsc → vite build → scripts/postbuild.mjs  (outputs web/dist)
```

`postbuild.mjs` emits per-route HTML shells (`dist/bridge/index.html`,
`dist/launch/index.html`) so link unfurls get the right OG/Twitter cards — every
shell boots the same SPA bundle. It also asserts the bundle ships no RainbowKit /
WalletConnect / metamask-sdk. `web/dist` is gitignored; the repo-root
`Dockerfile` runs this build on deploy (Railway) and serves `web/dist` with the
security headers + CSP in `public/serve.json`.

## Ethereum connection (wagmi-only)

`src/eth/wagmi.ts` creates a standalone wagmi `config` (mainnet, EIP-6963
discovery) and is loaded with a dynamic `import()` from `src/eth/EthProvider.tsx`,
so wagmi + viem stay out of the home's initial chunk. The connect UI
(`src/eth/EthConnect.tsx`) filters discovered connectors to MetaMask + Rabby.
There is no `WagmiProvider` / react-query in the tree — the bridge uses
`wagmi/actions` with the config directly.

## Extension id

`src/config.ts` exports `EXTENSION_ID` — the single place the Fizz extension id
lives. If the published Chrome Web Store id ever differs from the current dev id,
update it there and rebuild.

## House rules baked in

- Fee juice only, one-way L1→L2 only (protocol facts, stated in the UI).
- The canonical L1 contracts (FeeJuicePortal, the AZTEC fee asset) are fetched
  **live** from the Aztec mainnet node (`node_getNodeInfo`) and checked against a
  pin in `src/nodeInfo.ts` — never silently trusted.
- No analytics, no external fonts/CDNs; errors are surfaced verbatim with a retry.
