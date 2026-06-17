# Playwright E2E (browser extension)

End-to-end tests that drive the **built** Chrome MV3 extension (`dist/`) in a
real Chromium via Playwright. They complement the existing suites:

| Suite | Runner | What it covers |
| --- | --- | --- |
| `tests/unit`, `tests/fuzz` | Vitest | hermetic lib + property tests |
| `tests/e2e`, `tests/browser` | Vitest (+ Puppeteer) | lib against live networks; the **deploy publish-gate** smoke |
| `tests/playwright` | **Playwright** | **UI flows** through the real popup: launch, onboarding, lock/unlock, and a gated live-network boot |

## Prerequisites

```sh
yarn build                      # produces dist/ (the suite fails fast if missing)
npx playwright install chromium # one-time: download the browser binary
```

## Run

```sh
yarn test:pw            # light tier — launch + onboarding + unlock (no network)
yarn test:pw:headless   # same, headless (new headless)
yarn test:pw:ui         # Playwright UI mode (watch / time-travel)
yarn test:pw:network    # + live-network tier (boots the PXE on live alpha/mainnet)
yarn test:pw:funded     # the funded-* specs (needs configured accounts; see below)
yarn test:pw:report     # open the last HTML report
```

The **light tier runs by default and needs no network**: vault crypto runs
in-extension, so onboarding, validation, and lock/unlock are deterministic. The
test stops at the PXE "Connecting to…" screen rather than waiting for a node.

The **network tier is gated behind `PW_NETWORK=1`** (mirroring the `BROWSER=1`
Puppeteer gate). It boots the in-browser PXE against a live Aztec node and is
slow + environment-dependent.

## Env knobs

| Var | Effect |
| --- | --- |
| `PW_HEADLESS=1` | run headless (new headless). Default is **headed** — most reliable for MV3 + wasm. |
| `PW_NETWORK=1` | enable the live-network tier (boots a fresh wallet on live alpha/mainnet). |
| `PW_SPEND=1` | allow the funded WRITE tests (convert + cross-account transfer) that spend **real fees**. |
| `PW_CHANNEL=chrome` | use a branded channel instead of bundled Chromium. |
| `PW_EXECUTABLE_PATH=…` | point at a specific Chromium / Chrome-for-Testing binary. |

## Funded accounts (live prod testing)

The `funded-*` specs drive real wallet(s) on a live network — by default
**`alpha` (Aztec mainnet / prod)** — to test real balances, receive, token
import, conversion, and a true **between-accounts** transfer. No real
password/passkey is needed: the test sets its own throwaway password when it
imports the phrase (the mnemonic controls the funds).

Two modes (auto-selected from the config):
- **Same seed, two accounts** (default — `funded-cross-account.spec.ts`): provide
  one wallet `a` + a token. The test derives accounts 0 and 1 from that seed and
  transfers between them.
- **Two separate wallets** (`funded-cross-wallet.spec.ts`): also provide `b` with
  a *different* phrase → transfers between two extension instances.

They run only when funded accounts are configured. Provide them **either** way
(both are gitignored / never committed):

**Option A — file (recommended).** Copy the template and fill it in:

```sh
cp tests/playwright/.accounts.example.json tests/playwright/.accounts.local.json
# then edit .accounts.local.json
```

**Option B — environment:**

```sh
export PW_NETWORK_ID=alpha
export PW_ACCOUNT_A="<12 words>"      export PW_ACCOUNT_B="<12 words>"
export PW_TOKEN_ADDRESS=0x…           export PW_TOKEN_SYMBOL=TEST   # optional
```

Config fields (`.accounts.local.json`):

| Field | Meaning |
| --- | --- |
| `network` | `alpha` (live mainnet/prod), `testnet`, `devnet`, or `sandbox`. |
| `a.mnemonic` | the 12-word recovery phrase (**secret**). Same-seed mode uses its accounts 0 and 1. |
| `b.mnemonic` | *optional* — a **different** phrase, only for the two-separate-wallets mode. |
| `a.accountIndex` / `b.accountIndex` | *optional* — pin specific HD account indices (same-seed mode auto-detects which holds the token otherwise). |
| `a.password` / `b.password` | *optional* — local unlock password (defaults to the suite passphrase; no real password/passkey needed). |
| `token.address`, `token.symbol` | a **sendable** token held by one account — required for the transfer. AZTEC fee-juice (gas) is not directly sendable. |
| `amount` | amount to move in the transfer (default `"1"`). |

There's also a **passkey** test (`passkey.spec.ts`) — it uses a Chrome WebAuthn
virtual authenticator (PRF) to create + unlock a wallet with a passkey, no real
biometric and no credentials needed. (Funded wallets are reached via mnemonic
import, since a real device passkey is authenticator-bound and can't be reused.)

Then:

```sh
yarn build
yarn test:pw:funded            # read-only funded coverage (boot, balances, receive, import)
PW_SPEND=1 yarn test:pw:funded # + the live convert + cross-account transfer (spends real fees)
```

The read-only funded tests are safe to re-run (no on-chain spend). The convert
and cross-account transfer tests are gated behind `PW_SPEND=1` because they
publish real transactions and burn real fees on mainnet.

## Layout

```
playwright.config.ts          # runner config (testDir, timeouts, reporters)
tests/playwright/
  constants.ts                # paths, pinned id, launch flags, test secrets
  harness.ts                  # launchExtension(): one loaded-extension instance
  fixtures.ts                 # single-instance test fixtures (popup + console)
  flows.ts                    # create / lock flows (no creds)
  funded.ts                   # importWallet() + funded helpers
  accounts.ts                 # loads the gitignored funded-account credentials
  .accounts.example.json      # template → copy to .accounts.local.json
  pages/                      # page objects (resilient role/text locators)
  specs/                      # the tests (light, network, funded-*)
```

## Why a persistent context + headed default

MV3 extensions only load into a **persistent** Chromium context, never the
default ephemeral one. The launch flags in `constants.ts` are distilled from the
hard-won Puppeteer smoke test (`tests/browser/extension-smoke.test.ts`):
`--enable-unsafe-extension-debugging` (Chrome 137+ load-extension gate),
`--use-mock-keychain` / `--password-store=basic` (skip the macOS keychain
prompt), and `--disable-features=LocalNetworkAccessChecks` (let the in-popup PXE
reach a localhost sandbox node).
