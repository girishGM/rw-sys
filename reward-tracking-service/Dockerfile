# syntax=docker/dockerfile:1
#
# T-RTS-046 — the reward-tracking-service image. Multi-stage, non-root, no dev dependencies or
# source maps in the final layer, HEALTHCHECK against `GET /health` (src/health/health.controller.ts,
# T-RTS-001 — process liveness + a real DB connectivity check via `DbReachabilityService`; returns
# 503 with `{"status":"degraded","db":"unreachable"}` rather than 200 while the database is
# unreachable, so this HEALTHCHECK — and any external load balancer/orchestrator polling the same
# path — correctly treats a DB outage as "not ready", not "crash-looping").
#
# Mirrors `promo-code-service/Dockerfile`/`reward-redemption-service/Dockerfile`'s stage structure
# (deps -> build -> migrator -> prod-deps -> runtime), confirmed by direct read — this is the
# fourth service in this repo family built this way and there is no reason to diverge
# (ARCHITECTURE.md §4/§5). Built from THIS directory (`reward-tracking-service/`), not the repo
# root — see `render.yaml`'s own `dockerContext`/`dockerfilePath`.
#
# `node:20-bookworm-slim`, matching the portal's and every sibling service's own choice and root
# CLAUDE.md's Node 20 requirement (`package.json`'s own `engines`/`preinstall` check already
# enforce this for local dev).
#
# **One deliberate difference from the two sibling Dockerfiles this mirrors, worth calling out
# explicitly**: this service has FOUR standalone bootstrap entry points, not two —
# `dist/main.js` (the primary HTTP API: `/health` + the customer/admin rewards REST surface,
# T-RTS-001/030/032), `dist/grpc/grpc-server.main.js` (inbound `RewardTrackingIngestService`,
# T-RTS-011), `dist/kafka/kafka-consumer.main.js` (the `reward.redemption.completed.v1` consumer,
# T-RTS-012), and `dist/modules/ingestion/reward-tracking-ingest-http.main.js` (the REST-fallback
# ingest listener, T-RTS-013 — that file's own header flags it as "a standalone verification
# process" whose wiring into the single production HTTP app was left as a follow-up for
# `agent-rts-foundation`, still open as of this task; see this file's own "Deviations from spec"
# in the completion report). Exactly like `promo-code-service/Dockerfile`'s own header documents
# for its own two extra entry points, this single image compiles and ships all four into `dist/`
# but this file's own runtime `CMD` starts only the first. Running the other three as their own
# Render services from this SAME image (`dockerCommand:` overriding this file's default `CMD`) is
# named explicitly in `../reward-tracking-service-plan/reports/T-RTS-046-deploy-checklist.md` —
# it is a real deploy step, not a documentation nicety, so it does not stay implicit here.
#
# `proto/reward_tracking_ingest.proto` is copied into every stage that needs it (build, and then
# runtime) because `src/grpc/grpc-server.main.ts`'s own `resolveProtoPath()` resolves it at
# RUNTIME, relative to `__dirname`, two directories up from the compiled `dist/grpc/` — i.e.
# `<project-root>/proto/reward_tracking_ingest.proto`, exactly mirroring how it already resolves
# in local dev (`dist/` and `proto/` are siblings there too). Omitting this copy would make the
# gRPC ingest entry point crash on its very first request in the container, the exact class of
# "looks fine until someone tries the second entry point" gap this task exists to catch.

ARG NODE_IMAGE=node:20-bookworm-slim

# ---------------------------------------------------------------------------------------------
# Stage 1: install every dependency, including dev — needed to run `tsc`/`nest build`, not
# needed in the final image.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

COPY package.json package-lock.json ./

# `--ignore-scripts`: this project's own `prepare` script (`cd .. && husky
# reward-tracking-service/.husky`, package.json) assumes a git working tree one level up (the same
# reason every sibling service's own Dockerfile already documents) — a Docker build context has no
# `.git` at all. `preinstall`'s Node-major-version guard is also skipped here, harmlessly:
# `${NODE_IMAGE}` already pins Node 20 for every stage in this file.
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------------------------
# Stage 2: compile TypeScript -> `dist/` against the full dependency set above.
# ---------------------------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.json tsconfig.build.json ./
COPY src src
COPY proto proto

RUN npm run build \
 # No source maps of server code in the final image. `sourceMap: true` (tsconfig.json) is
 # correct for local debugging; stripping the emitted `.map` files here — after the build that
 # needed them, before the copy that ships them — keeps that setting rather than weakening it
 # for every other environment.
 && find dist -name '*.map' -delete

# ---------------------------------------------------------------------------------------------
# Stage 2a: the one-off migration job — never shipped as part of the `runtime` stage below, and
# not reachable by building this file without naming the target (`--target migrator`).
#
# Runs `src/database/cli/migrate.ts` via `ts-node` against the *source*, deliberately not
# `node dist/database/cli/migrate.js` against the compiled output — Umzug's migration glob is
# written against `.ts` filenames and would silently discover zero migrations against compiled
# `.js` output, reporting "Applied 0 migration(s)" indistinguishably from a genuinely up-to-date
# database (the identical reasoning both sibling Dockerfiles already give for their own
# `migrator` stage). `npm run db:migrate`/`db:rollback` (package.json) already use this exact
# `ts-node -T -r tsconfig-paths/register` invocation locally — this stage reuses the proven path,
# not a new one.
# ---------------------------------------------------------------------------------------------
FROM build AS migrator
WORKDIR /app
CMD ["npx", "ts-node", "-T", "-r", "tsconfig-paths/register", "src/database/cli/migrate.ts", "up"]

# ---------------------------------------------------------------------------------------------
# Stage 3: production-only node_modules — none of THIS project's own devDependencies (jest,
# ts-node, typescript, eslint, @nestjs/cli, @nestjs/testing, ...) anywhere in the tree that
# ships. `@types/node` may still show up under `node_modules/@types/node` even with
# `--omit=dev`: it arrives as a legitimate transitive *production* dependency of
# `@grpc/proto-loader` -> `protobufjs`, not this project's own devDependency of the same name —
# the same distinction both sibling Dockerfiles' own comments draw. Type declarations only,
# harmless either way.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------------------------
# Stage 4: the image that actually ships. Nothing from `deps`/`build` beyond `dist/`, `proto/`
# and the production `node_modules` crosses into this stage.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# A dedicated, unprivileged user — never the image's default root.
RUN groupadd --gid 1001 nodeapp \
 && useradd --uid 1001 --gid nodeapp --shell /usr/sbin/nologin --no-create-home nodeapp

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/proto ./proto
COPY --from=build /app/package.json ./package.json

USER nodeapp

# `PORT` (src/config/config.schema.ts, T-RTS-001) defaults to 3040 and is the only listener this
# runtime image opens BY DEFAULT — see this file's own header for the other three standalone entry
# points this same image ships but does not start from this default CMD.
EXPOSE 3040

# Node's own `http` client rather than curl/wget: neither ships in `-slim`, and this is a single
# GET with no other dependency. Hits `/health` (liveness + a real DB connectivity check —
# `health.controller.ts`) — a temporarily unreachable Postgres returns 503, matching this
# HEALTHCHECK's own "unhealthy" branch rather than crash-looping the container.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3040,path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/main.js"]
