# Chrome Web Store listing (draft)

## Name
Fizz — Private Aztec Wallet

## Summary (132 chars max)
Tokens with sparkle. A lightweight Aztec wallet for quick, low-value private
transactions — keys never leave your device.

## Description
The Aztec network is an Ethereum L2 where transactions can be PRIVATE — amounts,
senders, and recipients hidden by zero-knowledge proofs, generated on your own
machine.

Fizz is the lightweight way to use it — built for quick, everyday, low-value
transactions (pocket change, not vaults):

• Private AND public balances per token, side by side
• Send privately or publicly; convert between the two anytime
• Deploy your own tokens and mint supply — privately if you like
• In-browser proving (PXE): your keys and your data never leave the device
• Passkey (Touch ID / Windows Hello) or 12-word phrase unlock
• Multiple accounts from one phrase — keep activities unlinkable
• Sponsored network fees on testnet: start with zero balance
• Bring your own node for maximum privacy

Security posture (short version):
• Vault: AES-256-GCM, Argon2id, version-bound authenticated metadata
• All sensitive local metadata encrypted at rest under a key derived from your seed
• Strict MV3 CSP: default-src 'none', pinned network egress
• No analytics, no telemetry, no third-party requests — ever
• Idle auto-lock; clipboard auto-clear for secrets

Open source. Audited derivation paths with pinned regression vectors.

Fizz is alpha software on an alpha network, and it's deliberately a LIGHT
wallet: perfect for quick, low-value transactions; not built to be a vault.
Keep only what you'd carry in a pocket.

## Category
Productivity → Tools (or Finance where available)

## Screenshots needed (1280×800 or 640×400)
1. Home — private/public tabs with balances
2. Send — privacy toggle + confirm screen with full address
3. Receive — QR
4. Deploy token form
5. Mint screen

## Privacy practices questionnaire (answers)
- Single purpose: self-custodial wallet for the Aztec network.
- Permission justifications:
  - `storage`: persist the encrypted vault and wallet settings locally.
  - host permissions (localhost, *.aztec-labs.com): JSON-RPC to the user-selected
    Aztec node; localhost covers the local sandbox/own node.
- Remote code: none. All code is bundled; CSP forbids remote scripts.
- Data collection: none. No data leaves the device except JSON-RPC calls to the
  user's chosen Aztec node (required to read chain state and submit txs).
