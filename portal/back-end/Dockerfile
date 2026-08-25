# syntax=docker/dockerfile:1
#
# T-052 — the API image. Multi-stage, non-root, no dev dependencies or source maps in the
# final layer, and a HEALTHCHECK against GET /health (03-API-CONTRACT.md §14: liveness only,
# no dependency check — this is deliberately not /health/ready, whose 503 on a slow-starting
# database would flap the container's own health state for a condition compose's `depends_on`
# already handles).
#
# Built from the WORKSPACE ROOT (`portal/`), not from `back-end/` — see docker-compose.yml's
# `build.context`. `back-end` depends on `@reward-portal/shared` (an npm workspace, not a
# published package — resolved via the root node_modules symlink CLAUDE.md's own "Portal
# implementation status" section documents), so the root package.json/package-lock.json and
# packages/shared/src are all required inputs, not just back-end/src.
#
# `node:20-bookworm-slim` rather than an alpine base: `argon2` (T-011) ships prebuilt native
# bindings for glibc, not musl, so alpine would otherwise rebuild it from source on every
# image build (needing python3/make/g++ this Dockerfile doesn't install) — slim keeps the
# image small without that cost.

ARG NODE_IMAGE=node:20-bookworm-slim

# ---------------------------------------------------------------------------------------------
# Stage 1: install every workspace's dependencies once, including dev — needed to run
# `tsc`/`nest build`, not needed in the final image.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY back-end/package.json back-end/package.json
COPY front-end/package.json front-end/package.json

# `--ignore-scripts`: the root `prepare` script (`husky portal/.husky`) assumes a git working
# tree one level up (CLAUDE.md's own note on why), which a Docker build context does not have.
# Every script this stage actually needs (`tsc`, `nest build`) is run explicitly below instead.
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------------------------
# Stage 2: build packages/shared, then back-end, against the full dependency set above.
# ---------------------------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY packages/shared packages/shared
COPY back-end back-end

RUN npm run build -w packages/shared \
 && npm run build -w back-end \
 # TC-15: no source maps of server code in the final image. `sourceMap: true`
 # (back-end/tsconfig.json, T-001) is correct for local debugging; stripping the emitted
 # `.map` files here — after the build that needed them, before the copy that ships them —
 # keeps that setting rather than weakening it for every other environment.
 && find back-end/dist -name '*.map' -delete \
 && find packages/shared/dist -name '*.map' -delete

# ---------------------------------------------------------------------------------------------
# Stage 2a: the one-off migration job (docker-compose.yml's `migrate` service targets this
# stage explicitly, `target: migrator`) — never shipped as part of the `runtime` stage below,
# and not reachable by building this file without naming the target.
#
# Runs `src/database/cli/migrate.ts` via `ts-node` against the *source*, deliberately not
# `node dist/database/cli/migrate.js` against the compiled output — discovered while first
# verifying this compose file: `createMigrator()`'s migration glob
# (`back-end/src/database/umzug.ts`, T-002 — outside this task's file scope, R9) is hard-coded
# to `migrations/*.ts`, which matches nothing once `tsc` has compiled those files to `.js`, so
# the compiled CLI silently discovers zero migrations and reports "Applied 0 migration(s)" —
# indistinguishable from a genuinely up-to-date database. Filed as its own defect
# (see this task's completion report); `ts-node` against the `.ts` sources is the exact
# invocation every prior task's own verification already used successfully
# (`back-end/package.json`'s `db:migrate` script), so this is the already-proven path, not a
# new one — and the dev dependencies it needs (`ts-node`, `typescript`, `tsconfig-paths`) are
# fine here precisely because this stage is never part of the shipped `runtime` image TC-15
# governs.
# ---------------------------------------------------------------------------------------------
FROM build AS migrator
WORKDIR /app/back-end
CMD ["npx", "ts-node", "-T", "-r", "tsconfig-paths/register", "src/database/cli/migrate.ts", "up"]

# ---------------------------------------------------------------------------------------------
# Stage 3: production-only node_modules, no devDependencies anywhere in the tree, and scoped
# to the two workspaces the runtime image actually ships (back-end + the shared package it
# imports at runtime as a bare specifier, `@reward-portal/shared` — resolved via the workspace
# symlink `npm ci --workspace` creates, not a published registry package).
#
# TC-15 retry-2 fix (2026-08-23): this used to be a plain `npm ci --omit=dev --ignore-scripts`
# with no `--workspace` filter. That installs the production dependency graph of *every*
# workspace listed in the root package.json — including `front-end` — because npm workspaces
# creates a symlink and installs deps for each workspace whose package.json is present,
# regardless of whether another workspace actually depends on it. The result: this image's own
# node_modules shipped react/react-dom/react-router-dom/lucide-react (~200MB+ of front-end-only
# code the API never imports) purely because `front-end/package.json` was COPYed in above for
# the (unrelated) purpose of keeping this stage's COPY list symmetric with stage 1. Copying
# `front-end/package.json` is harmless by itself (a manifest, not code) — the bug was letting
# `npm ci` install *from* it. `--workspace=back-end --workspace=packages/shared
# --include-workspace-root=false` installs only those two workspaces' own dependency trees
# (confirmed live: `@reward-portal/shared`'s symlink is still created — required, see stage 4's
# comment — and react/react-dom/react-router-dom/lucide-react are absent; `luxon`/`moment`
# remain because they are genuine transitive deps of back-end's own `@nestjs/schedule`→`cron`
# and `sequelize`→`moment-timezone`, not front-end bleed — verified with `npm ls luxon moment
# --workspace=back-end`). `front-end/package.json` is still COPYed below for build-cache-layer
# symmetry with stage 1 and because `npm ci --workspace=...` still needs every workspace's
# package.json present to resolve the lockfile even when not installing that workspace's own
# deps; it is not, by itself, why front-end code was shipped.
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY back-end/package.json back-end/package.json
COPY front-end/package.json front-end/package.json

RUN npm ci --omit=dev --ignore-scripts \
      --workspace=back-end --workspace=packages/shared --include-workspace-root=false

# ---------------------------------------------------------------------------------------------
# Stage 4: the image that actually ships. Nothing from `deps`/`build` beyond the two `dist`
# directories and the production `node_modules` crosses into this stage.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# A dedicated, unprivileged user (TC-14) — never the image's default root.
RUN groupadd --gid 1001 nodeapp \
 && useradd --uid 1001 --gid nodeapp --shell /usr/sbin/nologin --no-create-home nodeapp

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/back-end/dist ./back-end/dist
COPY --from=build /app/back-end/package.json ./back-end/package.json

USER nodeapp
WORKDIR /app/back-end

EXPOSE 3000
# METRICS_PORT (default 9464, back-end/src/config/env.schema.ts) is intentionally NOT
# EXPOSEd here — see docs/DEPLOYMENT.md's Docker section for why an EXPOSE'd-but-unpublished
# port is still the wrong signal to leave in this file for the next person reading it.

# Node's own `http` client rather than curl/wget: neither ships in `-slim`, and adding one is
# an extra package for a single GET this task's own metrics server (`metrics-server.service.ts`)
# already proves is dependency-free in principle. Hits liveness only (see header) — a 503 from
# `/health/ready` is a "not ready yet" signal `depends_on`/orchestrator startup probes should
# see, not a reason to restart a container that is otherwise up.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/api/v1/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/main.js"]
