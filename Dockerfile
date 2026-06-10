# Railway deploy for fizzwallet.com — builds ONLY the web app (web/) and serves
# the static landing/ on $PORT. The browser extension is never built here.
#
# Stage 1 installs web/ deps, then `yarn build` runs tsc + vite and writes the
# /bridge + /launch pages into landing/{bridge,launch,webassets} next to the
# committed static home (index.html, privacy.html, images). Stage 2 serves that
# combined dir with the same security headers we enforce on Netlify, carried in
# serve.json (CSP, X-Frame-Options, etc.).
#
# VITE_WALLETCONNECT_PROJECT_ID is read at BUILD time (Vite inlines it). Set it
# as a Railway service variable; Railway passes service variables to the
# Dockerfile build as --build-arg, which the ARG below picks up.

# ── build ────────────────────────────────────────────────────────────────────
# Full node image (not -slim): it bundles python3 + a C toolchain, which some
# transitive optional native deps (e.g. msgpackr-extract) need to install. This
# stage is discarded; only the slim serve stage ships.
FROM node:22 AS build
WORKDIR /app
RUN npm install -g yarn@1.22.22 --force

# Install deps first (cached unless the lockfile changes).
COPY web/package.json web/yarn.lock ./web/
RUN cd web && yarn install --frozen-lockfile

# Source + the committed static landing (index.html, privacy.html, images).
COPY web ./web
COPY landing ./landing

ARG VITE_WALLETCONNECT_PROJECT_ID
ENV VITE_WALLETCONNECT_PROJECT_ID=$VITE_WALLETCONNECT_PROJECT_ID

# tsc + vite build, then deploy-to-landing.mjs writes bridge/launch/webassets
# into ./landing and sanity-checks the result (exits non-zero on any problem).
RUN cd web && yarn build

# ── serve ──────────────────────────────────────────────────────────────────--
FROM node:22-slim AS serve
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g serve@14

# landing/ from the build stage already includes serve.json (the security
# headers; serve reads it from the served dir) plus the built tool pages.
COPY --from=build /app/landing ./landing
# landing/README.md is internal docs; don't serve it.
RUN rm -f ./landing/README.md

# Railway provides $PORT; serve binds all interfaces so the platform can reach
# it. sh -c expands $PORT; exec form keeps signal handling clean.
CMD ["sh", "-c", "serve -l tcp://0.0.0.0:${PORT:-3000} landing"]
