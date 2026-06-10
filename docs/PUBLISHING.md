# Getting Fizz live on the Chrome Web Store

The runbook from "tested locally" to "installable from the store". Current
state: every wallet flow is verified on the public Aztec testnet (real proofs),
the package passes Chrome's MV3 manifest validation in the real-Chrome smoke
test, and the zip builds reproducibly.

## 0. Final pre-flight (every release)

```sh
yarn verify          # frozen-lockfile install + typecheck + 67 unit/fuzz tests + build
yarn test:e2e        # sandbox lifecycle 17/17 (needs `aztec start --local-network`)
BROWSER=1 yarn vitest run --project e2e tests/browser/extension-smoke.test.ts
yarn package         # → fizz-wallet-<version>.zip
```

Manual sweep in a real profile (chrome://extensions → Load unpacked → dist/):
create wallet → fund-free first tx on testnet (sponsored) → deploy token →
mint → private send to a second account → convert both ways → lock/unlock →
restore from phrase.

## 0.5 Stable extension ID (manifest `key`)

The manifest pins a public `key`, which fixes the extension ID to
`bapbaajfnjockbcdhjpgpllflnhgogol` for every unpacked install AND for the Web
Store build. fizzwallet.com/bridge and /launch message the wallet by this ID
(`externally_connectable`), so DO NOT remove or regenerate the key — doing so
orphans the web integration. There is no private half to protect.

## 1. One-time developer setup

1. Google account for publishing → https://chrome.google.com/webstore/devconsole
2. Pay the one-time $5 developer registration fee.
3. (Recommended) Set up a publisher group so the listing isn't tied to a
   personal account.

## 2. Create the listing

Dashboard → "New item" → upload `fizz-wallet-<version>.zip`.

Fill from `docs/STORE_LISTING.md`:
- Name, summary, description (lightweight / quick low-value positioning).
- Category: Productivity → Tools.
- Screenshots: 1280×800 — Home (private/public tabs), Send confirm screen,
  Receive QR, Deploy, Mint. Capture from the popup at 100% zoom.
- Icon: 128×128 (already in the zip; upload `src/assets/icon-128.png`).

**Privacy tab** (answers that match the code, verified by audit):
- Single purpose: self-custodial wallet for the Aztec network.
- Permissions: `storage` (encrypted vault + settings, local only);
  host permissions for localhost + *.aztec-labs.com (JSON-RPC to the user's
  chosen Aztec node).
- Remote code: **none** (everything bundled; CSP forbids remote scripts).
- Data collection: **none**. Link the hosted privacy policy
  (`docs/PRIVACY_POLICY.md` → publish at your landing domain, e.g.
  https://<your-domain>/privacy).

**Review notes for Google** (paste into the reviewer notes field):
> Fizz is a self-custodial wallet for the Aztec network (an Ethereum L2).
> It uses WebAssembly ('wasm-unsafe-eval' CSP) to generate zero-knowledge
> proofs locally; no code is fetched remotely. The `data:` connect-src entry
> exists because our bundler inlines a gzipped wasm artifact as a data: URL.
> The extension makes network requests ONLY to the user-selected Aztec node
> (defaults under *.aztec-labs.com, or localhost for local development).
> No analytics, no data collection.

## 3. Submit + rollout

1. Visibility: start **Unlisted** — installable by link, invisible in search.
   Share with alpha testers; iterate. Switch to Public when ready.
2. Review usually takes 1–3 days; wasm-heavy extensions occasionally get a
   manual review — the notes above preempt the common questions.
3. After approval, take the store URL and:
   - swap the landing page CTA (`landing/index.html` `#install` button),
   - update `landing/README.md`'s checklist item.

## 4. Versioning discipline

- Bump `version` in BOTH `package.json` and `src/manifest.ts` (keep identical).
- Tag the repo (`git tag v0.x.y && git push --tags`).
- Never change `DERIVATION_VERSION` or vault format without a migration —
  the pinned tests in `tests/unit/derivation.test.ts` will scream.

## 5. Known review risks & mitigations

| Risk | Mitigation |
|---|---|
| "wasm-unsafe-eval" flagged | Reviewer notes explain ZK proving; no remote code. |
| Large package (35 MB zip) | Well under the 2 GB limit; loads lazily at runtime. |
| Crypto-wallet policy review | Self-custodial, no exchange/fiat features, no data collection — standard allowed category. |
| `data:` in connect-src questioned | Bundled wasm inlined as data: URL; transmits nothing. |
