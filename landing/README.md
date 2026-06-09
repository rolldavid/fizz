# Fizz landing page

Self-contained static page — host the contents of this folder anywhere
(GitHub Pages, Netlify, a $0 static bucket). No build step.

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
