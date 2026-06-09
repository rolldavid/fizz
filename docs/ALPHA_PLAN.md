# Alpha deployment & migration plan

Where we are, what "alpha" means for Fizz, and the staged path to a public
alpha — plus the migration story for when Aztec's networks move.

## Current state (verified, on-chain evidence)

| Capability | Sandbox | Public testnet |
|---|---|---|
| Account create + first-tx activation | ✅ 17/17 e2e | ✅ sponsored, single tx |
| Token deploy / mint (private+public) | ✅ | ✅ |
| Private send + receive w/ note discovery | ✅ (independent PXEs) | ✅ (~60 s) |
| Shield / unshield | ✅ | ✅ |
| L1 fee-juice bridge → claim → consume | ✅ | ✅ (Sepolia, tx 0x27ed4f30…) |
| Pressure (many notes, storms, rapid sends) | ✅ 6/6 | n/a |
| Real-Chrome install + onboarding + vault | ✅ (Chrome for Testing gate) | same package |

Fee posture on testnet: **sponsored FPC** (verified live + funded) — new users
transact with zero balance; bridging is the self-sufficiency fallback.

## Alpha phases

### Phase A — Private alpha (now)
- DEFAULT network: **testnet**. Owner + invited testers, load-unpacked or
  Unlisted store link (docs/PUBLISHING.md).
- Exit criteria: the full manual sweep done by ≥3 people on ≥2 OSes without a
  blocking issue; no privacy/security regressions; proving times acceptable on
  mid-tier hardware.

### Phase B — Public alpha
- Store listing flips Unlisted → Public. Landing page live on Railway with the
  store CTA. Positioning everywhere: lightweight, quick, low-value.
- Monitoring (all client-side, no telemetry): publish a known-issues page;
  watch the sponsored FPC balance on testnet (it pays everyone's fees!) —
  alert if it drops low: script `node scripts/check-fpc-balance.mjs` (TODO) or
  simply re-run the probe in LOOP_STATE.
- Support loop: GitHub issues template w/ "what network / what screen / tx hash".

### Phase C — Aztec network migrations (testnet reset or "alpha → mainnet-ish")
Aztec's alpha phase means OCCASIONAL NETWORK RESETS and version bumps. The
wallet is built for this:

1. **Keys survive everything.** Accounts derive from the 12-word phrase
   (DERIVATION_VERSION 1, vectors pinned in tests). A network reset loses
   STATE, never KEYS — users re-derive identical addresses on the new chain
   (salt 0, reproducible in official tooling too).
2. **Per-network local state.** Tokens, contacts, known senders are scoped by
   network id — a reset network starts clean without nuking another network's
   data. Adding the next network = one entry in `networks.ts` (the `alpha`
   slot is already stubbed).
3. **Node/SDK compatibility.** PXE reads rollupVersion from the node;
   `nodeVersion` vs SDK semver matters at the minor level (4.3.0 SDK ↔ 4.3.1
   node verified). On an Aztec upgrade: bump `@aztec/*` deps together, run the
   full suite ladder (unit → sandbox e2e → testnet e2e), re-verify the
   sponsored FPC derivation (class id check — see LOOP_STATE "FPC
   reconciliation"; the fee probe self-heals but VERIFY).
4. **Migration checklist per network move:**
   - [ ] Add network entry; keep old one selectable during overlap.
   - [ ] Probe sponsored FPC on the new network (`fee.isSponsoredFPCAvailable`
         does this at runtime; confirm funding).
   - [ ] Run `TESTNET=1` suite against the new endpoint (env-override
         `AZTEC_NODE_URL` in scripts/testnet-smoke.mjs).
   - [ ] Ship extension update with the new default; in-app copy tells users
         the old network is read-only/sunset.
   - [ ] Landing + store listing copy updated.
5. **Vault/format migrations.** Envelope v2 binds its version into the AAD;
   any future format change bumps the version WITH a migration path (the
   anti-brick regression test enforces the discipline).

## Risks & mitigations (alpha-specific)

- **Sponsored FPC depletion** → flows fall back to bridge claims (verified);
  UI already explains. Watch balance; nudge Aztec team or fund it.
- **Testnet reorg/prune at 'checkpointed' tip** → rare; balances re-sync from
  chain truth; no user keys/funds at risk beyond the testnet's own guarantees.
- **Chrome review friction** → see PUBLISHING.md reviewer notes; keep Unlisted
  fallback link on the landing page.
- **SDK upgrades breaking internals** (e.g. `blockStateSynchronizer.sync`)
  → loud, named errors at the exact seams + the test ladder catches it.

## The "millions of dollars" caveat, made explicit

Fizz is deliberately positioned (UI, listing, landing) as a LIGHTWEIGHT wallet
for QUICK, LOW-VALUE transactions during alpha. The engineering bar stays
high — encrypted-at-rest metadata, CSP egress pinning, pinned derivation
vectors, four-layer test ladder — but the product promise to users is pocket
change, not vaults, until the network itself is past alpha.
