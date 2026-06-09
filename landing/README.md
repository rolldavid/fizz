# Fizz landing page

Self-contained static page — no build step. Hosted target: **Railway**.

## Deploy on Railway

1. railway.app → New Project → **Deploy from GitHub repo** → `rolldavid/fizz`.
2. Service settings:
   - **Root Directory**: `landing`
   - Railway auto-detects a static site (no build command, output = `.`).
     If it asks: Build command — none; Start command — none (static).
3. Networking → **Generate Domain** (or attach your custom domain).
4. Stamp that domain into the share metadata (step below) and redeploy.

## Before deploying

1. **Set your domain** in the share metadata (one command):

   ```sh
   sed -i '' 's|https://fizz-wallet.example|https://YOUR-DOMAIN|g' landing/index.html
   ```

   Link previews (Twitter/X especially) require absolute URLs for `og:image`,
   so this matters — relative paths silently break share cards.

2. **Swap the install CTA** once the Chrome Web Store listing is live: the
   primary button currently scrolls to the load-unpacked instructions
   (`#install`); point it at the store URL instead.

## Verify share cards

- https://cards-dev.twitter.com/validator (or paste the link in a DM to yourself)
- https://developers.facebook.com/tools/debug/
- Slack/Discord: paste the URL in any channel preview.

`ogfizz.png` is 2400×1260 (1.91:1) — the recommended large-card ratio.
