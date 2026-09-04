# syntax=docker/dockerfile:1
#
# realtime-activity-processing-service image. Multi-stage, non-root, no dev dependencies or
# source maps in the final layer, HEALTHCHECK against `GET /health` (src/health/health.controller.ts
# — process liveness + a raw TCP probe of DB_HOST/DB_PORT, deliberately not an authenticated
# query; see that file's own header for why).
#
# Mirrors `promo-code-service/Dockerfile`'s stage structure (deps → build → migrator →
# prod-deps → runtime) — same standalone, single-package shape, no npm workspace. Built from
# THIS directory (`realtime-activity-processing-service/`), not the repo root — see
# `render.yaml`'s own `dockerContext`.
#
# `node:20-bookworm-slim`, matching every other service in this repo and root CLAUDE.md's Node
# 20 requirement (`package.json`'s own `engines`/`preinstall` check already enforce this locally).

ARG NODE_IMAGE=node:20-bookworm-slim

# ---------------------------------------------------------------------------------------------
# Stage 1: install every dependency, including dev — needed to run `tsc`/`nest build`, not
# needed in the final image.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

COPY package.json package-lock.json ./

# `--ignore-scripts`: this project's own `prepare` script (`cd .. && husky
# realtime-activity-processing-service/.husky`, package.json) assumes a git working tree one
# level up — a Docker build context has no `.git` at all. `preinstall`'s Node-major-version
# guard is also skipped here, harmlessly: `${NODE_IMAGE}` already pins Node 20 for every stage.
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------------------------
# Stage 2: compile TypeScript → `dist/` against the full dependency set above.
# ---------------------------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.json tsconfig.build.json ./
COPY src src

RUN npm run build \
 # No source maps of server code in the final image — `sourceMap: true` (tsconfig.json) is
 # correct for local debugging; stripping the emitted `.map` files here keeps that setting
 # rather than weakening it for every other environment.
 && find dist -name '*.map' -delete

# ---------------------------------------------------------------------------------------------
# Stage 2a: the one-off migration job — never shipped as part of the `runtime` stage below, and
# not reachable by building this file without naming the target (`--target migrator`).
#
# Runs `src/database/cli/migrate.ts` via `ts-node` against the *source*, deliberately not
# `node dist/database/cli/migrate.js` against the compiled output — umzug's migration glob is
# written against `.ts` filenames and would silently discover zero migrations against compiled
# `.js` output, reporting "Applied 0 migration(s)" indistinguishably from a genuinely
# up-to-date database. `npm run db:migrate`/`db:rollback` already use this exact `ts-node -T -r
# tsconfig-paths/register` invocation locally — this stage reuses the proven path.
# ---------------------------------------------------------------------------------------------
FROM build AS migrator
WORKDIR /app
CMD ["npx", "ts-node", "-T", "-r", "tsconfig-paths/register", "src/database/cli/migrate.ts", "up"]

# ---------------------------------------------------------------------------------------------
# Stage 3: production-only node_modules — none of this project's own devDependencies (jest,
# ts-node, typescript, eslint, @nestjs/cli, @nestjs/testing, ...) anywhere in the tree that ships.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------------------------
# Stage 4: the image that actually ships. Nothing from `deps`/`build` beyond `dist/` and the
# production `node_modules` crosses into this stage.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# A dedicated, unprivileged user — never the image's default root.
RUN groupadd --gid 1001 nodeapp \
 && useradd --uid 1001 --gid nodeapp --shell /usr/sbin/nologin --no-create-home nodeapp

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

USER nodeapp

# `PORT` (src/config/config.schema.ts) defaults to 3020 and is the only listener this runtime
# image opens — the gRPC ingestion server (src/grpc/, own `GRPC_SERVER_PORT`, default 50071),
# the Kafka ingest consumer (src/messaging/ingest/), and the customer progress API (its own
# `PROGRESS_API_PORT`) are separate standalone entry points this stage compiles into `dist/` but
# does not start; `src/app.module.ts` (the module `dist/main.js` boots) only wires
# ConfigModule + HealthModule today, mirroring promo-code-service's own REST-only Render
# deployment for the same platform reason (see that service's CLAUDE.md "Traps already hit
# once" #2 — Render terminates TLS at its own edge, which the gRPC server's mTLS guard needs).
EXPOSE 3020

# Node's own `http` client rather than curl/wget: neither ships in `-slim`, and this is a single
# GET with no other dependency. Hits `/health` (liveness + DB-reachability only).
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3020,path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/main.js"]
