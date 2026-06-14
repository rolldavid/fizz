# Security

Fizz is a Chrome MV3 browser-extension wallet for the Aztec Network. The private execution environment (PXE) and all zero-knowledge proving run client-side, in the browser; secret material never leaves the user's device, and outbound traffic is constrained to a small set of pinned hosts. The design favors failing loudly over failing silently: when a precondition is not met, the wallet surfaces an actionable error rather than guessing, masking the fault, or risking funds.

This document describes the wallet's security model and the measures behind it. The properties these measures enforce are catalogued in [`INVARIANTS.md`](./INVARIANTS.md).

## Threat model

**In scope.** Fizz is built to defend the user against remote and network-level adversaries:

- Malicious or compromised dapps and websites attempting to hijack approval flows, poll for cross-origin data, or coerce fund-moving actions.
- Hostile or misconfigured RPC nodes attempting to serve the wrong network, an incompatible protocol version, or forged answers to membership queries.
- Network observers and the broader surveillance surface around L1/L2 activity — addressed through egress restriction, isolation, and honest disclosure.
- Data-integrity faults: malformed persisted entries, concurrent read-modify-write races, reorg windows, and unbounded or untrusted inputs.
- Supply-chain tampering in the build toolchain and runtime dependencies.

**Explicitly out of scope.** As with any browser-based wallet, the user's own device and operating system are part of the trusted computing base. An attacker with local disk access *plus* live memory access to an already-unlocked profile is outside the model — that capability defeats browser wallets generally. Within the model, the wallet protects key material and the data it manages at rest under encryption, gates unlock behind authentication, and clears in-memory secrets on lock and on browser restart. Hardening of this boundary is ongoing.

## Key custody & cryptography

The mnemonic and account metadata are protected under derived keys, with unlock gated by a passphrase or a passkey.

- **Passphrase KDF.** Argon2id with memory-hard parameters set well above OWASP password-hashing floors. A dedicated test enforces those minimums so a future change cannot silently weaken the KDF.
- **Vault encryption.** The vault envelope is sealed with AES-GCM, and the envelope version is bound into the AES-GCM AAD to prevent downgrade attacks and silent format shifts.
- **Metadata at rest.** Account metadata is encrypted with AES-256-GCM under a key derived via HKDF-SHA256 with a fixed info string — deterministic per seed and independent of the vault key, so it survives reinstall and restore-from-phrase. The AAD binds the storage key name, preventing ciphertext substitution across fields.
- **Passkey unlock.** The WebAuthn PRF extension enables passkey unlock requiring authenticator verification (biometric or PIN), with no password.
- **Brute-force resistance.** Failed passphrase attempts incur escalating delays before the next (deliberately expensive) Argon2 derivation, and the delay persists across popup reopen.
- **Session model.** On unlock, only the 32-byte seed is cached in memory-backed session storage (wiped on browser restart, bounded by TTL). The session blob is authenticated with an HMAC derived from the vault-envelope binding material and verified in constant time; any substitution or modification is rejected and the invalid blob self-clears. Session clearing is awaited as the final step of `lock()` and `destroy()`, closing the window in which a lock during an in-flight persist could leave a stale seed in memory.
- **Minimized secret lifetime.** The mnemonic string is returned once and never cached — only the 32-byte seed is held — and decrypted byte buffers are zeroed immediately after use.

## Keeping funds safe

The wallet treats every fund-moving path as untrusted until proven safe.

- **Authenticated double-spend gates.** Before a bridged fee-juice claim is marked consumed, its L1→L2 message consumption is verified through a node membership witness keyed to the PXE-synced block hash. The witness leaf preimage must exactly equal the locally computed nullifier; a mismatched or low-value witness is rejected. The check anchors to checkpointed (L1-verified) block state rather than the unproven tip — closing reorg windows — and replaces unauthenticated node queries that could otherwise be used to falsely consume a claim.
- **Self-healing recovery.** On an RPC error or a non-membership witness, the sweep fails safe and leaves the claim pending for a later tick. A separate recovery scan reads deposit events from L1 and re-adopts a wrongly-consumed claim. A malformed claim entry is logged and skipped, never aborting the whole tick.
- **Atomic, non-colliding claim indices.** Claim-index allocation performs read, increment, and write inside a single serialized closure, so every caller receives a distinct index across popup instances and browser restarts. A fresh import must complete claim recovery before the first index is allocated, and an empty scan never permanently latches the recovery flag — it is set only after a full-range scan confirms the tip.
- **Input bounds on untrusted tickets.** Claim-ticket amounts are validated against the u128 ceiling at the import entry point, matching the recovery path, so no amount reaches token operations unchecked. Fund-moving guards reject zero/negative amounts and the zero address as a recipient.
- **No silent loss — errors propagate.** The wallet does not swallow errors, fall back to default values, or blindly retry. A required value that is missing throws.
- **Post-broadcast safety.** The transaction hash is captured immediately after `send()` succeeds, before any fee bookkeeping. If bookkeeping then fails, the failure is wrapped in a `PostBroadcastBookkeepingError` carrying the captured hash, and humanized messaging directs the user to Activity with that hash — a maybe-landed transaction is never blindly resubmitted. A wallet-lock during a send produces actionable guidance to unlock and check Activity. Error-bucket precedence (post-broadcast, wallet-locked, receipt, pre-broadcast sync) is enforced by tests.
- **Accidental double-submit guards.** High-impact actions (Send, Convert, Mint) use synchronous double-tap guards, so a rapid second click cannot launch a duplicate operation.

## Privacy protections

- **Egress firewall.** The manifest `connect-src` is a strict allowlist (the extension's own origin and bundler-inlined WASM, the pinned production endpoints, the pinned test/dev hosts, and the proving-CRS host); localhost appears only in development builds. `externally_connectable` is restricted to the project's exact origin with no wildcard subdomain, preventing subdomain-takeover egress. A build gate enforces these egress restrictions and blocks navigation-class escapes from slipping into the bundle.
- **Address scrubbing in errors and logs.** All error text passes through a single description chokepoint that handles `DOMException`, `Error`, and generic objects, redacting addresses and hashes before anything is displayed or recorded. Scrubbing is uniform across contact errors, transaction-history lookups, UI displays, and background message responses; a lint guard blocks direct address interpolation in error contexts, and dapp-authorization logs are address-blind.
- **Per-account & per-network isolation.** Transaction history, claim indices, recovery markers, contacts, and known-sender sets are namespaced per network and per account, with no cross-account or cross-network spillover. A regression test confirms accounts cannot cross-see each other's bridge cards.
- **Token-field sanitization.** Token names and symbols have control and format characters stripped and are length-capped per field.
- **Transparent disclosures.** The bridge-confirm screen discloses that the user's Ethereum address and Aztec account become permanently linked in the L1 transaction; the explorer link discloses that opening it shares the user's IP with the explorer. Both are shown inline, without extra friction.

## State integrity & concurrency

- **PXE lock.** A promise-chain lock serializes user-initiated PXE operations (send, estimate, deploy, sync). Synchronous re-entrancy is detected and rejected loudly instead of hanging, and the lock chain is reset at wallet teardown so a hung operation cannot block the next boot.
- **Serialized stores.** Token mutations, connection writes, per-account transaction-history writes, and account-metadata mutations each chain through serialized closures, eliminating read-modify-write clobbering across concurrent adds and scan-driven inserts.
- **Bridge mutations.** Pending-bridge read-modify-write cycles are serialized; a cross-window snapshot can never unset terminal flags (consumed / landing-tx markers are preserved on every write).
- **Background ticks.** The auto-claim tick uses an in-flight latch and a completion-scheduled cadence (not a fixed interval), so ticks never overlap. Idle auto-lock accounts for in-progress operations but is bounded by a hard ceiling, so the unlocked window is always finite. Account-deploy promises are keyed by address to prevent cross-account contamination, and account switching uses a monotonic sequence token so only the latest switch completes.
- **Per-entry validation & bounded inputs.** Connections, transaction history, contacts, and other persisted lists validate and sanitize each entry on read, filtering malformed rows instead of crashing. Amounts, claim tickets, custom-node URLs, and bridge wei values are bounds-checked at entry. Forward-only caps and time-based pruning of terminal entries prevent unbounded growth and quota exhaustion.
- **Resilient rendering & migration.** History amounts parse via safe BigInt with fallback rendering, and per-entry render guards show a stub rather than white-screening the list. A content-stable dedupe key keeps RPC event reordering from duplicating rows. Legacy schemas migrate forward on first load, with concurrent loads coalesced onto a single in-flight migration. An initialization failure renders a "reload" card rather than an infinite spinner.

## Network & node trust

- **Node-identity verification.** On every connection, the node's L1 chain-ID and protocol/rollup version are verified against the configured network, with a clear user-facing error on mismatch. Custom-node URLs are validated against the host allowlist and re-validated at boot even if previously allowed, so a now-blocked host is rejected. An unreachable or wrong-identity node surfaces an honest boot error rather than silently proceeding.
- **Anchored proofs.** Membership and consumption checks are rooted to checkpointed, L1-verified committed-block state rather than the unproven tip, preventing reorg-window false positives. L1 RPC is used read-only for receipt verification, and L1→L2 message inclusion is validated against on-chain state.
- **WASM proving isolation.** `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` enable `SharedArrayBuffer` for multi-threaded proving while keeping the document cross-origin-isolated.

## Supply chain

- **Pinned dependencies.** Runtime SDK packages (`@aztec/*`) and the cryptography libraries (`@noble/*`, `@scure/*`) are pinned to exact versions in the lockfile, and all devDependencies are pinned to exact versions (no `^`/`~` ranges), making the build toolchain tamper-evident at install.
- **Build-time gates.** A postinstall hook applies curated patches and fails the build if any patch no longer applies cleanly. A fail-closed gate keyed off the build environment controls the manifest `connect-src`, `externally_connectable`, and host permissions, so a non-production build cannot re-add localhost to a release. Source maps are stripped from production builds.

## Testing & verification

The repository carries 160+ automated unit, property, and concurrency tests, plus live end-to-end browser suites:

- **Cryptography & derivation.** Argon2id KDF, AES-GCM round-trips, passphrase NFKC normalization, pinned address-derivation vectors, and a floor test that enforces the OWASP KDF minimums.
- **Privacy & errors.** Error-description totality and address-scrubbing across every input shape, transaction-error classification and bucket-priority precedence, and regression guards that catch banned egress patterns and address-leak interpolation in source.
- **State & concurrency.** Serialized-mutation and race-detection tests for tokens, connections, contacts, history, claim-index allocation, and bridge lifecycle/spend locks, plus per-entry validation and rejection of malformed persisted entries.
- **Network & CSP.** Assertions that every allowed node host is a subset of `connect-src`, that `connect-src` contains no wildcards, and that production network entries are pinned.
- **Live end-to-end.** Real MV3 browser smoke tests (onboarding, passphrase creation, PXE boot, token deploy with actual proofs), sandbox runs (shield/unshield, private and public transfers, L1→L2 bridge), live testnet runs with client-side proving and note discovery, and pressure tests for concurrent polling, large note aggregation, and rapid sends.

Approaches include property testing, real-KDF slow-path verification, concurrency race detection, and source-tree regression guards. Independent security audits have been performed against the wallet, and hardening continues as an ongoing process.

## Reporting a vulnerability

We welcome responsible disclosure. If you believe you have found a security issue, please report it **privately** and give us a reasonable window to investigate and remediate before any public disclosure. Please avoid testing against accounts or funds that are not your own.

- **Preferred:** open a private report through this repository's **Security → Report a vulnerability** (GitHub private vulnerability reporting).

Please include a clear description, reproduction steps, the affected version or commit, and any relevant logs (with addresses and secrets redacted). We will acknowledge your report, keep you updated on remediation, and credit reporters who wish to be acknowledged.
