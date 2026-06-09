# Fizz (browser extension)

Tokens with sparkle. Fizz is a lightweight dark-mode Chrome MV3 wallet for the
Aztec network — built for quick, low-value transactions (pocket change, not
vaults). Deep-grape UI, pink accents, bubbles where they belong.

A static landing/splash page lives in `landing/` — self-contained HTML you can
host anywhere; it explains the benefits and links to installing the extension.

- In-browser **PXE** — your secret keys never leave this device.
- **Passkey** (WebAuthn PRF) or **12-word phrase** to unlock the vault.
- **Public + private balances** per token, on separate tabs.
- **Send/receive** private or public, plus shield/unshield (Convert) — with a
  full-address confirmation screen before anything signs.
- **Mint** new supply on tokens where you hold the minter role (private or public).
- **Multiple accounts** from one phrase — switch instantly; keep funding and
  spending unlinkable.
- **Receive UX**: QR with identicon, native share, save QR, optional amount/memo encoded into an `aztec:` URI.
- **Deploy tokens** directly from the wallet — AIP-20 standard, choose initial supply public or private, optionally renounce minter role.
- **Fees**: sponsored-FPC detection (testnet covers your fees — start from zero),
  fee-juice balance, one-click sandbox bridge, claim auto-consumed by your first tx.
- **Custom node** support — point the wallet at your own Aztec node.
- Sensitive local metadata (contacts, bridge claims) encrypted at rest; strict
  `default-src 'none'` CSP with pinned egress; idle auto-lock.
- **Auto theme** — follows browser light/dark; toggle to override.
- Sandbox / Testnet (alpha) / custom network switching.

## Stack

Vite + React + TypeScript + `@crxjs/vite-plugin` for MV3. `@aztec/wallets/embedded` for the in-browser PXE.

## Dev

```sh
nvm use 22
yarn install
yarn dev          # vite dev server at http://localhost:5173 (also serves a debug popup)
```

Then in Chrome → `chrome://extensions` → **Load unpacked** → pick the project root (`dist/` after `yarn build`, or `dist/` directly when using vite dev — CRXJS writes the manifest there as you save).

Add icons in `src/assets/` (see `src/assets/README.md`).

### Run a local Aztec sandbox

```sh
aztec start --local-network
```

Node defaults to `http://localhost:8080`. Select **Local sandbox** in the wallet's network picker.

## Build

```sh
yarn build
```

Loads from `dist/`.

## Testing

```sh
yarn test          # unit + fuzz (fast-check) — hermetic, fast
yarn test:e2e      # full lifecycle against a live local sandbox (start it first)
TESTNET=1  yarn vitest run --project e2e tests/e2e/testnet.test.ts   # real proofs vs public testnet
PRESSURE=1 yarn vitest run --project e2e tests/e2e/pressure.test.ts  # stress: many notes/tokens
BROWSER=1  yarn vitest run --project e2e tests/browser/extension-smoke.test.ts  # real Chrome, built MV3
```

The browser smoke test needs Chrome for Testing once:
`npx @puppeteer/browsers install chrome@stable`

`yarn verify` = frozen-lockfile install + typecheck + unit tests + build.
`yarn package` = verify + zip the extension for the Web Store.

The unit suite pins the mnemonic→account derivation vectors
(`tests/unit/derivation.test.ts`). If those ever fail, DO NOT update the
expectations — a derivation change strands every existing user's funds.

## Architecture sketch

```
src/
├── manifest.ts             # MV3 manifest (cross-origin isolated)
├── background/             # service worker (tiny, room to grow)
├── popup/
│   ├── App.tsx             # status machine: uninitialized → locked → loading → ready
│   ├── pages/              # Onboarding, Unlock, Home, Send, Receive, Bridge
│   └── components/
└── lib/
    ├── vault/              # passkey, mnemonic, AES-GCM, chrome.storage envelope
    ├── aztec/              # networks, EmbeddedWallet wiring, token + fee balances,
    │                       # transfer flows, L1 fee juice portal bridge
    ├── state/walletContext.tsx
    └── storage.ts          # thin chrome.storage.local wrapper
```

The popup hosts the PXE because MV3 service workers get torn down too aggressively to hold long-lived proving state, and extension pages already have the cross-origin isolation needed for bb.js WASM threads.
