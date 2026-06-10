# Fee juice on alpha — deep review & recommended pattern

**Problem.** On the alpha network there is no faucet, and a sponsored FPC may
not exist (or may be rate-limited/drained). Every transaction needs fee juice,
fee juice lives only on L2, **it is non-transferable on L2**, and the ONLY door
into it is the L1 → L2 bridge. So the wallet must give users a first-class way
to: hold the AZTEC token on L1 → deposit through the FeeJuicePortal → claim on
L2 — without owning a separate L1 wallet extension.

## 1. Ground truth (verified in SDK 4.3.0 + live on testnet)

The canonical path, end to end:

```
AZTEC (ERC20, L1)
  │  approve(portal, amount)                ── L1 tx #1
  ▼
FeeJuicePortal.depositToAztecPublic(
  to = L2 address, amount, secretHash)      ── L1 tx #2
  │  emits DepositToAztecPublic → L1→L2 message
  ▼  (message enters the L2 in-tree after the inbox lag — minutes)
FeeJuice.claim(to, amount, secret, leafIndex)   ── L2 tx, OR:
FeeJuicePaymentMethodWithClaim                  ── claim consumed AS the fee
                                                    of the user's next tx
                                                    (incl. atomic account
                                                    deploy + claim — verified)
```

- `L1FeeJuicePortalManager.bridgeTokensPublic(to, amount, mint=false)` does
  exactly approve + deposit (portal_manager.js:119-138) and resolves the
  portal + fee-asset addresses **from the node's `l1ContractAddresses`** — no
  hardcoding; the same code works on any network, including alpha, the moment
  the node publishes its addresses.
- Public-only: there is no private fee-juice deposit (fee juice balances are
  public by protocol design). Privacy implications handled in §4.
- Claim params (`claimAmount`, `claimSecret`, `messageLeafIndex`) are minted
  client-side at deposit time. **Whoever runs the deposit holds the secret** —
  this constrains the UX patterns below.
- Measured costs (testnet pricing): account-deploy+claim 2.25 FJ; heavy tx
  ~2.3 FJ. **100 AZTEC bridged ≈ 40+ transactions.**
- Our claim pipeline is already production-verified: encrypted-at-rest pending
  claims, readiness checked at the PXE's true anchor (non-nullified witness),
  auto-consume on next tx, atomic deploy+claim for fresh accounts.

## 1.5 SHIPPED ARCHITECTURE (2026-06-09): three clean surfaces

The product split the flows (owner direction):

- **The extension is just a wallet** — send / receive / convert / balances.
  Token deployment is no longer on Home.
- **fizzwallet.com/bridge** — fee juice in, from ANY Ethereum wallet
  (RainbowKit), to ANY Aztec address. Fee juice only; one-way by protocol
  (FeeJuicePortal.depositToAztecPublic is the single canonical entry; the
  deposit asset is the L1 fee ERC20, never ETH; no user exit exists). After
  the deposit the page hands the wallet a **claim ticket**
  (`fizzclaim1:base64url` — src/lib/aztec/claimTicket.ts) via
  `chrome.runtime.sendMessage` (externally_connectable), with copy-paste
  import as fallback (Bridge → "Import claim ticket"). The wallet's next
  transaction auto-pays with the claim.
- **fizzwallet.com/launch** — token launcher. The page sends a draft
  (`fizz:launch-token`) to the extension; the extension opens its own
  standalone window pre-filled at #deploy where the USER reviews and deploys
  (keys and even the user's address never touch the page); the page polls
  `fizz:launch-status` for the public result (token address + tx hash).

The in-wallet funding account (pattern A below) REMAINS as the
no-external-wallet path on the extension's Bridge page. Fund-safety invariant
shipped with it: the claim secret is persisted BEFORE any L1 broadcast, with
a status lifecycle (depositing → sent → pending → failed) and receipt-based
recovery — a popup death can no longer strand a deposit.

## 2. Candidate patterns, compared

### A. In-wallet L1 account (derived from the same 12 words) — ★ RECOMMENDED
The wallet derives a **standard Ethereum account** (BIP-44 `m/44'/60'/0'/0/0`)
from the existing mnemonic and runs the L1 side itself with a viem local
account over a public RPC (we already proved this exact signing pattern in
`tests/e2e/helpers.ts: sepoliaKeyProvider`).

UX: Bridge screen shows "Your L1 funding address" (+ QR) with live AZTEC & ETH
balances → user sends AZTEC (+ a little ETH for gas) to it from anywhere
(CEX withdrawal, their main wallet) → one click runs approve+deposit → claim
auto-consumes on their next Fizz tx.

- ✅ Self-contained: no MetaMask/WalletConnect; works in the popup.
- ✅ Claim secret never leaves the wallet (generated and stored encrypted
  in-place — no handoff).
- ✅ Recoverable: BIP-44 means the same 12 words restore the L1 account in any
  Ethereum wallet — users can always rescue stranded L1 funds.
- ✅ Privacy-flexible: funding the L1 address straight from a CEX withdrawal
  creates no on-chain link to the user's main L1 identity (§4).
- ⚠️ Needs ETH for L1 gas (two txs) — show an explicit "gas tank" line with
  the ~cost estimate; block the button until both balances suffice.
- ⚠️ A second hot key derived from the seed — same protection class as the
  Aztec key (never persisted decrypted; derived on demand from the unlocked
  seed; CSP egress pinning applies). Add the L1 RPC origin to connect-src.

### B. Companion bridge page on fizzwallet.com (MetaMask exists there)
A web page does approve+deposit from the user's existing L1 wallet, then hands
the claim params to the extension (paste, or `externally_connectable`
postMessage pinned to fizzwallet.com).

- ✅ Serves users whose AZTEC sits in their main wallet and who won't move it.
- ✅ Zero new key material in the extension.
- ❌ Claim-secret handoff is the weak joint (copy/paste loss, phishing surface,
  a page that must be exactly right). The Nethermind faucet uses this pattern
  out of necessity; it's a fallback, not the primary.
- Verdict: **ship later as the "advanced" path**, claim-param paste UI already
  half-exists (PendingBridge import would be ~50 lines).

### C. WalletConnect inside the popup — rejected
Heavy dependency (+MB), session relay infra, QR-pairing friction in a 380px
popup, and it still ends at the same approve+deposit. Nothing it does better
than A for this single, rare operation.

### D. Third-party relayer / onramp ("pay fees in any token") — future
An FPC whose operator accepts token X and pays fee juice is the protocol-native
answer (that's literally what FPCs are for), but it's an operator business,
not a wallet feature. Revisit when alpha has live FPC operators; our fee
resolution already auto-detects FPCs on-chain, so adoption would be config,
not code.

## 3. Recommended implementation (Phase 1, ~1–2 days)

1. `src/lib/vault/l1Account.ts` — derive secp256k1 key at `m/44'/60'/0'/0/0`
   from the seed (viem `mnemonicToAccount` equivalent — but derive from OUR
   seed bytes via `@scure/bip32` to avoid retaining the mnemonic; expose
   address + a signer factory; key wiped after each use).
2. `src/lib/aztec/l1Bridge.ts` — viem public+wallet client on the network's
   L1 RPC; read AZTEC (`l1ContractAddresses.feeJuiceAddress`) + ETH balances;
   `bridgeFromInWalletAccount(amount)` → existing `bridgeFeeJuice()` with a
   local-account provider (the `sepoliaKeyProvider` pattern, productionized).
3. Bridge screen rework: funding-address card (QR + copy + balances) → amount
   presets ("~20 txs / ~40 txs / custom") → progress (approve → deposit →
   "claim arrives in a few minutes; your next transaction uses it
   automatically") → done state. Linkability warning stays.
4. Manifest: add the L1 RPC origin(s) to `connect-src` + host_permissions
   (alpha's L1 is Ethereum mainnet — pin the specific RPC we default to, keep
   custom-RPC setting).
5. Tests: unit (derivation vector pinned for the L1 path!), e2e on sandbox
   (anvil already funds the derived address via `anvil_setBalance` +
   handler-mint), gated Sepolia run reusing the existing claim assertions.

## 4. Privacy analysis

- The deposit is public on L1 either way: `(L1 funder → portal → L2 recipient,
  amount)` is world-readable forever (audit finding C1 — the warning UX
  exists). Pattern A makes the GOOD path easy: CEX → in-wallet L1 address →
  bridge means the visible funder is a fresh address with no history.
- Recommend in-UI: "fund this address from an exchange for best privacy; avoid
  sending from a wallet that's publicly you."
- Bridge to a **separate Fizz account index** than the one used for private
  spending (multi-account exists) — suggest it in the flow.
- Fee juice balances and spends are public by design; amounts bridged are
  visible. Suggest round presets to blend (20/40-tx bundles).

## 5. Failure modes & handling

| Mode | Handling |
|---|---|
| ETH present, approve ok, deposit fails | approve persists; retry runs only deposit (idempotent allowance check). |
| Claim params lost (reinstall) | Pending claims live in encrypted storage; reinstall + same phrase re-derives the META KEY → claims recovered. Cross-device: params are re-derivable only if we also store them — document "finish your bridge on the device you started it." |
| Message not yet in-tree | Existing anchor-true readiness check; UI says "arriving…" (verified behavior). |
| Account not yet deployed | Atomic deploy+claim (verified on testnet, single tx, 2.25 FJ). |
| Spent-claim re-offer | Non-nullified witness check excludes it (verified). |
| Alpha addresses unknown today | All addresses come from the node at runtime; zero hardcoding to update. |

## 6. Open questions for the Aztec team before alpha

1. Will a sponsored FPC exist on alpha at launch (even rate-limited)? Our
   resolver auto-detects it; it changes the FIRST-RUN story only.
2. Does the alpha AZTEC L1 token implement EIP-2612 permit? (Would collapse
   approve+deposit into one L1 tx.)
3. Any L1→L2 message expiry/retention policy we should surface in UX?
4. Recommended public L1 RPC for wallet defaults (rate limits matter).
