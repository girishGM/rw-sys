# syntax=docker/dockerfile:1
#
# tracking-service's image. Multi-stage, non-root, no dev dependencies in the final layer —
# same shape as portal/back-end/Dockerfile, simplified: no shared workspace package to build
# first, and no migration stage (tracking-service owns no database; every migration-shaped
# concept it has is in-memory, seeded at boot from the real portal API — see
# test-app-plan/ARCHITECTURE.md).
#
# Built from the WORKSPACE ROOT (`test-app/`), not from `tracking-service/` alone — same reason
# as portal/back-end/Dockerfile: this is an npm-workspaces project, so the lockfile
# (`package-lock.json`) lives once at the workspace root, not per-package. `frontend/package.json`
# is copied in too, for the same reason portal/back-end/Dockerfile copies `front-end/package.json`
# — `npm ci --workspace=...` still needs every workspace's manifest present to resolve the
# lockfile, even though it only installs the named workspace's own dependency tree.
#
# node:20-bookworm-slim to match the rest of this repo's Node images.

ARG NODE_IMAGE=node:20-bookworm-slim

# ---------------------------------------------------------------------------------------------
# Stage 1: install tracking-service's own dependencies, including dev — needed to run `tsc`.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY tracking-service/package.json tracking-service/package.json
COPY frontend/package.json frontend/package.json

RUN npm ci --ignore-scripts --workspace=tracking-service --include-workspace-root=false

# ---------------------------------------------------------------------------------------------
# Stage 2: build.
# ---------------------------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tracking-service tracking-service

RUN npm run build -w tracking-service \
 && find tracking-service/dist -name '*.map' -delete

# ---------------------------------------------------------------------------------------------
# Stage 3: production-only node_modules, scoped to tracking-service only (same reasoning, and
# same `--workspace` fix, as portal/back-end/Dockerfile's own prod-deps stage — an unscoped
# `npm ci --omit=dev` would install every workspace's deps, including frontend's react/
# react-dom/react-router-dom this service never imports).
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY tracking-service/package.json tracking-service/package.json
COPY frontend/package.json frontend/package.json

RUN npm ci --omit=dev --ignore-scripts --workspace=tracking-service --include-workspace-root=false

# ---------------------------------------------------------------------------------------------
# Stage 4: the image that actually ships.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --gid 1001 nodeapp \
 && useradd --uid 1001 --gid nodeapp --shell /usr/sbin/nologin --no-create-home nodeapp

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/tracking-service/dist ./tracking-service/dist
COPY --from=build /app/tracking-service/package.json ./tracking-service/package.json

USER nodeapp
WORKDIR /app/tracking-service

EXPOSE 4001

# GET /health is liveness-only (no dependency check) — same reasoning as portal/back-end's own
# HEALTHCHECK comment: a slow/failed portal login on boot is a "not ready" condition Render's
# own deploy log surfaces, not a reason to flap the container's restart state.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||4001,path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]
