# Railway deploy for fizzwallet.com — the single-page web app (web/). The
# browser extension is never built here.
#
# Stage 1 installs web/ deps and runs `yarn build` (tsc + vite + postbuild),
# which emits the SPA into web/dist: index.html, hashed /assets, per-route
# shells (/bridge, /launch), the static privacy page, images, and serve.json.
# Stage 2 serves web/dist on $PORT with the security headers + SPA fallback that
# serve.json carries (CSP, X-Frame-Options, ** -> /index.html rewrite).

# ── build ────────────────────────────────────────────────────────────────────
# Full node image (not -slim): it bundles python3 + a C toolchain, which some
# transitive optional native deps need to install. This stage is discarded.
FROM node:22 AS build
WORKDIR /app
RUN npm install -g yarn@1.22.22 --force

# Install deps first (cached unless the lockfile changes).
COPY web/package.json web/yarn.lock ./web/
RUN cd web && yarn install --frozen-lockfile

# Source, then build the SPA into web/dist.
COPY web ./web
RUN cd web && yarn build

# ── serve ──────────────────────────────────────────────────────────────────--
FROM node:22-slim AS serve
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g serve@14

# web/dist already includes serve.json (security headers + SPA rewrite; serve
# reads it from the served dir), the per-route shells, and static assets.
COPY --from=build /app/web/dist ./site

# Railway provides $PORT; serve binds all interfaces so the platform can reach
# it. sh -c expands $PORT; exec form keeps signal handling clean.
CMD ["sh", "-c", "serve -l tcp://0.0.0.0:${PORT:-3000} site"]
