# Fizz landing page

Self-contained static page — **no build step**. Plain HTML + assets.

## Deploy on Railway

The repo-root `Dockerfile` builds the web app (`web/`) and serves the combined
`landing/` (this home + the generated `/bridge`, `/launch`, `webassets/`) on
`$PORT` with the security headers in `/serve.json`.

1. railway.app → New Project → **Deploy from GitHub repo** → `rolldavid/fizz`.
   `railway.json` pins the Dockerfile builder, so no build settings are needed.
2. Variables → set `VITE_WALLETCONNECT_PROJECT_ID` (read at build time; enables
   the WalletConnect connector on `/bridge`).
3. Networking → attach the custom domain.

## Domain

Production domain is **fizzwallet.com** — already stamped into the canonical
link and all OG/Twitter share tags (absolute URLs, as Twitter/X requires).
Attach the custom domain to the Railway service (Networking → Custom Domain →
`fizzwallet.com`, plus the CNAME it shows you at your DNS provider).

## Before going live

**Swap the install CTA** once the Chrome Web Store listing is live: the
primary button currently scrolls to the load-unpacked instructions
(`#install`); point it at the store URL instead.

## Verify share cards

- https://cards-dev.twitter.com/validator (or paste the link in a DM to yourself)
- https://developers.facebook.com/tools/debug/
- Slack/Discord: paste the URL in any channel preview.

`ogfizz.png` is 2400×1260 (1.91:1) — the recommended large-card ratio.
