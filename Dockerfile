# syntax=docker/dockerfile:1

# ==============================================================================
# FluxFlow - single container, single process, single port.
#
# Replaces the v1 image, which ran Express on 3000 and SvelteKit on 4173 with a proxy
# between them, shipped a C++ toolchain to build better-sqlite3 at image-build time, and
# never worked when reached by anything other than localhost (#9, #11, #22).
# ==============================================================================

# ─── deps ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

# better-sqlite3 ships prebuilt binaries for Node 22 on linux-x64, so no toolchain is
# needed. `libc6-compat` is required by the prebuilt .node file; python3/make/g++ are only
# installed for the platforms where no prebuild exists.
RUN apk add --no-cache libc6-compat python3 make g++

WORKDIR /app

# Only the manifests, so this layer is cached until dependencies actually change.
COPY package.json package-lock.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts=false

# Rebuild the native module for this exact platform/ABI, then drop the toolchain need.
RUN npm rebuild better-sqlite3

# ─── build ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

RUN apk add --no-cache libc6-compat python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .

# SvelteKit -> build/ (adapter-node), and the server entry -> dist/ (tsc).
RUN npm run build \
 && npm run build:server

# ─── runtime ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# tini reaps zombies and, critically, forwards SIGTERM to node. Without a real init the
# container gets SIGKILLed after the grace period, which is how v1 lost blocks mid-write
# (#14): its own SIGTERM handler called process.exit(0) immediately.
RUN apk add --no-cache libc6-compat tini

# The git SHA of this build, passed by `docker compose build` (deploy/redeploy.sh sets it).
# `/api/health` reports it, so a redeploy can prove the new code is the code answering.
ARG GIT_SHA=dev
LABEL org.opencontainers.image.revision=$GIT_SHA       org.opencontainers.image.source=https://github.com/2ndtlmining/fluxflow

ENV NODE_ENV=production     APP_VERSION=$GIT_SHA \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/data/flux-flow.db \
    LABELS_PATH=/app/config/labels.json

WORKDIR /app

# Production dependencies only, carried over from the build stage.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/config ./config

RUN mkdir -p /app/data && chown -R node:node /app

USER node

# One port serves both /api and the web app.
EXPOSE 3000

VOLUME ["/app/data"]

# O(1) and dependency-free: no curl or wget in the image, and no table scans (#3).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Ingestion commits in batches; give the in-flight transaction time to finish rather than
# being SIGKILLed mid-write.
STOPSIGNAL SIGTERM

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
