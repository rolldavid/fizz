# Fizz landing page

Self-contained static page — **no build step**. Plain HTML + assets.

## Deploy on Netlify (current)

`netlify.toml` at the repo root handles everything (base `landing`, publish
`.`, empty build command) and **overrides UI settings** — so a failed
`yarn run build` configured in the dashboard is ignored once this file is on
`main`. Just connect the repo and deploy; no dashboard build settings needed.

If you'd rather fix it in the UI instead: Site configuration → Build &
deploy → set **Build command** to *(empty)* and **Publish directory** to
`landing` (with Base directory `landing`, publish is `.`).

Custom domain: Domain management → add `fizzwallet.com` → follow the DNS
instructions (apex A/ALIAS + `www` CNAME). HTTPS is automatic.

## Deploy on Railway (alternative)

1. railway.app → New Project → **Deploy from GitHub repo** → `rolldavid/fizz`.
2. Root Directory `landing`; no build command; static output `.`.
3. Networking → attach the domain.

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
