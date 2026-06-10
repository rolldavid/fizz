# Fizz — security posture

A five-surface adversarial audit (Aztec/Noir protocol integration, privacy/
correlation, vault cryptography, extension IPC/manifest, and the web app) was
run against the wallet, the `/bridge` page, and the `/launch` page. Result:
**no Critical, one High** (now fixed), plus Mediums/Lows fixed below. This file
records what was fixed and the residuals deliberately accepted, with rationale.

## Fixed

### High
- **Node-trusted L1 addresses (web `/bridge`).** The page reads the
  FeeJuicePortal + fee-asset addresses from the Aztec node, then signs
  `approve()`/`depositToAztecPublic()` against them — a hostile node could
  redirect funds. `web/src/nodeInfo.ts` now **pins** the canonical Sepolia
  portal + asset and hard-fails on mismatch (fetch-live-then-assert).
- The extension-side equivalent (`bridgeFeeJuice` / the in-wallet L1 funder)
  was **removed entirely** — see "Attack-surface removed."

### Medium
- **Prod manifest trusted localhost** (`connect-src` + `externally_connectable`).
  `src/manifest.ts` is now a `(env) => manifest` function: production drops
  `http://localhost:*`/`127.0.0.1:*` from `connect-src` (the seed-exfil channel)
  and `http://localhost/*` from `externally_connectable`. Mirrors the existing
  `import.meta.env.PROD` gate in the background worker.
- **`fizz:launch-token` window-spam DoS.** Rate-limited to one launch window per
  8 s via `storage.session` (`src/background/index.ts`).
- **No security headers on the static site.** Added `landing/_headers`:
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy`, COOP, and an enforcing CSP pinning `connect-src` to the
  Aztec node + Sepolia RPC + WalletConnect relay.
- **Recipient not field-element-checked (web).** `/bridge` now rejects an Aztec
  address ≥ the BN254 modulus before depositing (a 64-hex-but-out-of-range
  paste would have stranded funds on L1).
- **Custom remote nodes silently CSP-blocked.** `validateCustomNodeUrl` now
  rejects non-`localhost`/non-`*.aztec-labs.com` origins up front with an honest
  explanation instead of an opaque fetch failure (privacy.html updated to match).

### Low / hardening
- **Vault version-gate brick (latent).** `RETIRED_VAULT_VERSIONS` set replaces a
  blanket `v < VAULT_VERSION` rejection, so a future format bump won't brick
  existing vaults (the AAD already binds each envelope's own version).
- **Metadata-at-rest AAD.** `metaCrypto` v2 blobs bind the storage key into
  AES-GCM AAD (blocks cross-key ciphertext substitution / rollback); legacy v1
  blobs are read and transparently re-written as v2.
- **Zeroization.** Decrypted-mnemonic bytes, the TextEncoder copy handed to
  encrypt, the 64-byte BIP-39 seed intermediate, and the seed-derivation hash
  buffers are now `.fill(0)`'d after use.
- **Argon2id** raised 64 MiB → **128 MiB** (t=3) — non-bricking (params are
  per-vault in the envelope).
- **Salt decode** moved inside the unlock try/catch (no raw DOMException past the
  neutral failure wrapper; preserves the no-oracle property).
- **Claim-ticket** length caps (hex ≤128, decimal ≤78, networkId ≤32); inbox
  reads guard `Array.isArray`.
- **Plaintext claim window removed.** A pasted ticket is written **straight into
  the encrypted store** (`importClaimTicketText`); the plaintext inbox is gone
  (no external writer remained). `drainClaimInbox` is kept only to migrate a
  legacy inbox on upgrade.
- **Deploy-draft TTL** (5 min) so a stale launch-token draft can't pre-fill a
  much-later manual Deploy.
- **Prod log level** `LOG_LEVEL=error`; contact-log addresses redacted to a
  short prefix.
- **Event match** on the web deposit now also binds `to` + `amount` (not just
  the unique secret hash).
- **Web ledger** validates each record, expires after 14 days, caps at 100, and
  offers "Clear saved bridges."

## Attack-surface removed
- **The in-wallet L1 funding account** (`l1Funding.ts`, `vault/l1Account.ts`,
  the vault's L1 private key, the `publicnode` egress origin, and the
  `fizz:claim-ticket`/`fizz:connect`/`fizz:connect-status` IPC + the connect
  approval window) is **gone**. Fee-juice bridging now happens on
  fizzwallet.com/bridge with the user's OWN Ethereum wallet (RainbowKit), so the
  derived L1 key — a second seed-derived secret previously held in popup memory
  on every unlock — no longer exists. This also resolves the privacy finding
  that one shared L1 funding address would link multiple Aztec accounts.
  > If you ever want a no-external-wallet, in-app funding path back, re-add it
  > with a **per-account** L1 derivation (`m/44'/60'/0'/0/{index}`) and an
  > explicit user-confirmation step before signing any L1 tx.

## Accepted residuals (documented, not code-changed)
- **Skip-class-publication trusts the node** (`wallet.ts`). A lying node can
  cause a deploy to burn one bootstrap fee-juice claim and leave the account
  undeployed. Requires a malicious node, is recoverable (re-bridge), and the
  on-chain witness still prevents any double-spend. Deeper fix (detect the
  publication-conflict revert and retry) is noted for a future pass.
- **Auto-registering payees as PXE senders** (`contacts.ts`) expands the
  node-observable tag-query set (a social-graph fingerprint to a curious node).
  It's required for reciprocal private-note discovery; disclosed in the privacy
  policy. Making broad auto-registration opt-in is a candidate future change.
- **Concurrent fee resolution across two popups** could attach the same claim to
  two txs (one fails at inclusion; self-griefing, retryable, no loss). A
  cross-process lock needs shared storage coordination; not worth the
  complexity for a light wallet.
- **Spent-but-uncleared claims** can show as "pending" in the bridge list until
  reconciled (display-only; fee usage is gated by the on-chain witness).
- **`fizzwallet.netlify.app`** remains a trusted external origin (the owner's
  active staging host). Drop it from `externally_connectable` once
  fizzwallet.com is the sole domain.
- **PXE-derived signing keys** live in IndexedDB unencrypted at rest (SDK
  behavior). The crown-jewel mnemonic is vault-encrypted; the derived spend keys
  are not. Noted; outside this repo's crypto.
