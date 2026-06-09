# Performance baseline — 2026-06-09 (SDK 4.3.0, Apple Silicon)

Measured during the e2e verification campaign. Update when the SDK or proving
stack changes.

## Proving (ClientIVC, real proofs, Node 24 wasm — testnet runs)
| Operation | Proof generation | Witness generation | End-to-end (incl. inclusion) |
|---|---|---|---|
| Account deployment | 4.4 s | 0.77 s | ~154 s |
| Token deployment | 3.9 s | 0.75 s | ~99 s |
| mint_to_private | 4.0 s | 0.77 s | ~44 s |
| unshield / shield / transfers (testnet) | ~4 s | <1 s | 47–84 s |

End-to-end is dominated by L2 inclusion + sync, not proving. In-extension
proving uses bb.js threads (COOP/COEP enabled); expect similar order of
magnitude on desktop hardware.

## Sync freshness
- `syncChainTip: "checkpointed"` (current default): fresh deploys usable and
  incoming funds visible within ~1 block (~30–60 s observed on both networks).
- `"proven"` (rejected): testnet proven tip lags ~36 blocks ≈ 20+ min — fresh
  deploys unusable, deposits invisible. Documented trade-off in wallet.ts.

## Package
- Unpacked dist: 64 MB (wasm + circuit artifacts dominate; Token artifact 5.9 MB
  and all kernel circuits are lazy-loaded chunks).
- Web Store zip: 35 MB (limit: 2 GB — ample headroom).
- No source maps in production builds.

## Pressure suite (PRESSURE=1, sandbox, 6/6 passed)
- 4 token deploys back-to-back: 38 s total
- Popup-open balance storm (4 tokens × 3 rounds, parallel): 731 ms
- Balance aggregated from 12 individual notes: discovered + correct in ≤54 s
  (12 sequential mints dominate; reads instant)
- Many-note transfer (10 of 12 one-unit notes in one tx): handled (5 s)
- 4 rapid sequential private sends: exact final balances on both sides
- 20 concurrent utility simulations: 452 ms, all consistent

## Sandbox e2e wall-clock
- Full 17-scenario lifecycle: ~10–22 min (sandbox L2 slots ~72 s dominate; each
  chain-settling assertion needs 1–2 blocks).

## Known hot spots / future work
- First popup open downloads + compiles wasm (one-time per session): the
  "Booting the in-browser PXE" screen covers it; measure cold vs warm in the
  browser smoke harness when stable.
- Token artifact chunk (5.9 MB) could be trimmed by importing only the
  artifact JSON needed (currently whole contract class module).
- Note-heavy accounts: see tests/e2e/pressure.test.ts (PRESSURE=1) for the
  aggregation + note-selection limit probes.
