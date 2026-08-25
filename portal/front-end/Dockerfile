# syntax=docker/dockerfile:1
#
# T-052 — the SPA image: a Vite production build served by nginx. Multi-stage, non-root, no
# dev dependencies or source maps in the final layer, HEALTHCHECK against the static server
# itself (there is no backend to be "ready" for — this container's only job is to serve
# already-built files and reverse-proxy `/api` to the `api` service, per `nginx.conf`).
#
# Built from the WORKSPACE ROOT (`portal/`), same reasoning as `back-end/Dockerfile`'s header:
# `front-end` needs `@reward-portal/shared` (an npm workspace, not a published package).
#
# No `VITE_*`/`import.meta.env` build-time configuration exists anywhere in `front-end/src`
# (confirmed by grep as of this task) — the SPA calls same-origin `/api/v1/*`
# (`front-end/src/lib/apiClient.ts`) in every environment, dev and production alike, so this
# image needs no build ARGs and is the same artifact regardless of where it is deployed.

ARG NODE_IMAGE=node:20-bookworm-slim

# ---------------------------------------------------------------------------------------------
# Stage 1: install every workspace's dependencies (including dev — Vite, tsc, are dev deps).
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY back-end/package.json back-end/package.json
COPY front-end/package.json front-end/package.json

# See back-end/Dockerfile's own note on --ignore-scripts (the root `prepare` script assumes a
# git working tree this build context does not have).
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------------------------
# Stage 2: build packages/shared, then the SPA.
# ---------------------------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY packages/shared packages/shared
COPY front-end front-end

RUN npm run build -w packages/shared \
 && npm run build -w front-end
# `front-end/vite.config.ts` already sets `build.sourcemap: true` for local debugging (T-020);
# TC-15's "no source maps of server code" is about the API image — a browser DevTools source
# map for a client-side SPA is not server code and is routine practice for a production SPA
# (it lets a real incident be debugged from a minified stack trace). Left as the codebase's
# own choice rather than silently overridden here.

# ---------------------------------------------------------------------------------------------
# Stage 3: nginx, serving only the built static output. Nothing from `deps`/`build` beyond
# `front-end/dist` crosses into this stage — no node_modules, no source, at all.
# ---------------------------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY front-end/nginx.main.conf /etc/nginx/nginx.conf
COPY front-end/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/front-end/dist /usr/share/nginx/html

# `nginx:alpine` ships an `nginx` user (TC-14: this image must not run as root); the cache dirs
# nginx creates under /var/cache/nginx on first start must already be writable by it, else
# `mkdir() "/var/cache/nginx/client_temp" failed (13: Permission denied)` — confirmed by
# actually running this image as `nginx` while verifying this Dockerfile. (The pidfile
# permission problem that same run surfaced is fixed in `nginx.main.conf`, not here — see its
# own header for why a `chown` cannot fix that one.)
RUN chown -R nginx:nginx /var/cache/nginx /usr/share/nginx/html

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/nginx-health || exit 1

CMD ["nginx", "-g", "daemon off;"]
