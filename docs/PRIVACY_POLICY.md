# Privacy Policy — Aztec Wallet extension

_Last updated: 2026-06-09_

## The short version
We collect nothing. The wallet has no servers, no analytics, no telemetry, and
no accounts. Everything it stores, it stores on your device, encrypted.

## What the extension stores locally
- Your encrypted vault (the 12-word recovery phrase encrypted with AES-256-GCM
  under a key derived from your passkey or passphrase).
- Wallet metadata — contacts, known senders, pending bridge claims, account
  labels — encrypted at rest under a key derived from your seed.
- Non-sensitive settings (selected network, theme, token display list).
- The Aztec PXE database (notes, sync state) in IndexedDB.

None of this leaves your device.

## What the extension transmits
The wallet speaks JSON-RPC to ONE party: the Aztec node you select (a public
node we preconfigure, or any node you choose, including your own). Like any
light wallet, that node necessarily sees your IP address, the addresses you
query, and the transactions you submit. Choosing your own node removes that
trust in a third party. We operate no node and receive no traffic ourselves.

If you open the testnet faucet, that's a normal website visit to its operator —
we deliberately do NOT include your address in the link.

If you bridge from L1, the L1 transaction is public, like any Ethereum
transaction, and links your L1 address to your Aztec address. The wallet warns
about this in-flow.

## What we (the developers) receive
Nothing. We have no way to identify you, contact you, or see your activity.

## Changes
Material changes to this policy ship with an extension update and a changelog
entry.
