# Invariants

An *invariant* is a property that must always hold — regardless of how the software is used, what order operations run in, or how an attacker probes it. For a wallet that moves real funds, invariants are the backbone of safety: they state precisely what the system guarantees so that users, auditors, and integrators can reason about it without reading every line of code. The list below describes properties Fizz enforces today, in plain language, grouped by concern.

Fizz is a Chrome MV3 browser extension for the Aztec Network. The private execution environment (PXE) and zero-knowledge proving run entirely client-side, in the browser. The threat model treats the user's own device and operating system as trusted: an attacker with local disk access and live memory access to an already-unlocked profile is out of scope, as is standard for any browser wallet. The guarantees below describe what is protected within that model.

## Cryptography & key material

How the master seed, vault sealing, session caching, and key derivation behave.

- The master seed is stored in a vault envelope sealed with AES-256-GCM. The plaintext header metadata (version, method, salt, KDF parameters) is bound as additional authenticated data (AAD), so any tampering with — or downgrade of — the header fails authentication.
- When the wallet locks, the master seed buffer is immediately zeroed so it cannot be read back from memory.
- The account-derivation version is pinned and never silently rolled over; any change requires explicit migration logic.
- The session seed cache stores only the seed, never the mnemonic, and is bounded by TTL, browser restart, and idle timeout.
- Locking immediately clears the session seed cache, so a locked wallet cannot silently re-unlock.
- The passphrase is Unicode-normalized (NFKC) before key derivation, ensuring consistent vault access across devices with different text-normalization behavior.
- At-rest key derivation uses a non-extractable Web Crypto key, so key material cannot be exported through the Web Crypto API.
- Outbound network egress is constrained by a Content-Security-Policy `connect-src` allowlist covering all fetch-class operations.

## At-rest encryption & storage

How encrypted persistence and data organization work in browser storage.

- Every value the wallet persists through its secure-storage layer — key names excepted — is encrypted at rest with AES-256-GCM under a seed-derived meta-key, with the ciphertext bound to its storage key as AAD.
- Encrypted values are accessible only while the wallet is unlocked; the secure-storage layer refuses reads and writes while locked.
- History, contacts, connections, and token lists are length-capped with deterministic eviction, so list growth cannot exhaust the storage quota.
- A bridge "prepare" persists the pending claim to encrypted storage *before* broadcasting the transaction, so a popup closing during the broadcast window cannot lose the claim secret.
- The seed-derived bridge claim index is allocated monotonically and never reused across the wallet's lifetime.

## Network & node trust

How the wallet communicates with nodes, validates custom nodes, and stays protocol-safe.

- Every network connection is configured through an allowlisted network registry.
- Custom-node URLs are validated: the validator rejects disallowed localhost addresses in production, and persisted custom nodes are re-validated on load.
- The chain identity (L1 chain-ID and protocol/rollup version) is re-verified during boot and on every network switch, with a clear user-facing error on mismatch.
- Host permissions and the `externally_connectable` allowlist contain only exact hostnames; no wildcards are permitted.
- Every allowed node host is a strict subset of the CSP `connect-src` allowlist.
- The production mainnet node is pinned and its identity is verified on every connection; an unreachable or wrong-identity node surfaces an honest error rather than silently proceeding.
- The PXE syncs to a checkpointed, L1-verified tip rather than the unproven proposed tip, avoiding inclusion against state that could reorg within a slot.

## Concurrency & serialization

How access to mutable state is serialized to prevent races.

- All PXE access is serialized through a module-global promise chain, so the in-browser key-value store cannot race with concurrent operations.
- A single transaction operation holds the PXE lock continuously from send through on-chain inclusion, so other operations see consistent state for that window.
- The pending-bridges read-modify-write is serialized, so concurrent callers cannot clobber the list.

## Account deployment & boot

How accounts are created, first-booted, and initialized.

- Account deployment is protected against duplicate proving by a single-use initialization nullifier (which prevents replayed deployment transactions) and a broadcast journal that records the predicted address at the moment of broadcast.
- Boot registers all visible accounts into a single in-browser PXE instance and performs sender-sync across the union of all accounts' senders.
- Boot ordering is enforced: critical initialization steps complete in a defined sequence before the UI marks the wallet ready.

## Bridge fee-juice deposit lifecycle

How fee juice is bridged from Ethereum to Aztec, and how the claim is handled and consumed.

- The bridge claim secret is derived from the wallet's master seed and never transmitted or exposed across the page boundary; only the claim secret *hash* is ever public on-chain.
- The claim secret hash is bound to the recipient, amount, and other deposit parameters through the claim-ticket structure.
- The seed-derived claim index and secret are versioned; any derivation change requires explicit migration.
- Before a claim is marked consumed, its consumption is verified against authenticated on-chain state (see *Keeping funds safe* in the security policy), and a wrongly-consumed claim self-heals on a later recovery scan.

## Authorization & dapp communication

How the dapp-to-wallet channel and signing control behave.

- The wallet never produces an authorization witness (authwit) from the dapp message channel without an explicit user gesture in the wallet UI.
- Private key material, the master seed, and signing capability never cross the page boundary into untrusted code.
- Connection origins are enforced and scoped, so an unapproved origin cannot act as an approved one.
- A dapp cannot trigger signing by message alone — every signature requires an in-wallet interaction.

## Privacy & plaintext exposure

How sensitive data is kept out of logs, the network, and untrusted contexts.

- No source-of-truth secret (master seed, mnemonic, or private keys) reaches the web page or is accessible to untrusted code.
- The CSP `connect-src` allowlist blocks fetch-class egress of any material to non-allowlisted hosts.
- The session seed cache is protected from untrusted browser contexts (content scripts, web pages) by its storage access level.
- Addresses and hashes are redacted from error text and logs before they can be displayed or recorded.

## Error handling & recovery

How errors are classified and how the wallet fails safely.

- Error description handles every input shape without crashing and produces output safe for logging or display.
- Transaction errors are classified into distinct categories so user-facing messaging is accurate and a maybe-landed transaction is never presented as a simple "retry."
- Lock-race errors (a mutation failing because the wallet locked mid-operation) are distinguished from other error types.
- The wallet does not swallow errors, fall back to masking defaults, or blindly retry; a required value that is missing throws rather than proceeding on a guess.

## State integrity & UI safety

How the wallet guards against malformed state and user error.

- Persisted lists validate and sanitize each entry on read, filtering malformed rows instead of crashing the view.
- Amounts are bounds-checked (positive, within the u128 ceiling) at every entry point, including untrusted claim tickets and the recovery path.
- Forward-only count caps and time-based pruning keep local stores bounded so growth cannot exhaust the quota.
- Privacy-eroding actions (e.g. moving funds from private to public) and high-impact submissions are single-flighted and gated, so a rapid double-tap cannot launch a duplicate operation.
- An initialization failure renders an actionable "reload" path rather than an infinite spinner.

## Build identity & supply chain

How extension identity, release hygiene, and dependency integrity are protected.

- The extension signing key is byte-identical to the last published release; key rotation is forbidden, because it would orphan every existing user vault.
- The manifest version matches the package version and is strictly greater than the last published tag.
- CSP is locked down: script execution is restricted to the extension's own bundle and WASM, with no external script execution permitted.
- The permission set is minimal — only what the wallet needs to function.
- Every dependency, including transitive ones, is exact-pinned (no `^`/`~` ranges); duplicate instances of a package resolve to one identical version.
- Build-time patches must apply cleanly: a failed patch fails the build rather than silently falling through to an unpatched dependency.
- Production builds ship no source maps, and verbose logging is compiled out.

## PXE & proving

How the in-browser private execution environment is constrained.

- The PXE runs entirely in-browser with no remote component; all proof generation and transaction building happen locally.
- All visible accounts share one PXE instance and therefore one network vantage point — a deliberate, disclosed privacy characteristic.

---

These properties are enforced in code and covered by automated tests, fuzz/property checks, and live end-to-end browser runs. Security is a continuous effort, and hardening is ongoing. For the measures behind these guarantees, see [`SECURITY.md`](./SECURITY.md).
