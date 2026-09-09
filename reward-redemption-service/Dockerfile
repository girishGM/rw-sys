# syntax=docker/dockerfile:1
#
# T-RR-001 — the reward-redemption-service image. Multi-stage, non-root, no dev dependencies or
# source maps in the final layer, HEALTHCHECK against `GET /health` (src/app.controller.ts's own
# trivial placeholder today — process liveness only, no DB check; T-RR-004 supersedes this
# controller's behavior with a real, config-driven version without changing this Dockerfile).
#
# Mirrors `promo-code-service/Dockerfile`'s stage structure (deps → build → migrator →
# prod-deps → runtime), confirmed by direct read — this is the third service in this repo built
# this way and there is no reason to diverge (ARCHITECTURE.md §1/§4). Built from THIS directory
# (`reward-redemption-service/`), not the repo root — see `render.yaml`'s own
# `dockerContext`/`dockerfilePath`.
#
# `node:20-bookworm-slim`, matching the portal's and both sibling services' own choice and root
# CLAUDE.md's Node 20 requirement (`package.json`'s own `engines`/`preinstall` check already
# enforce this for local dev).

ARG NODE_IMAGE=node:20-bookworm-slim

# ---------------------------------------------------------------------------------------------
# Stage 1: install every dependency, including dev — needed to run `tsc`/`nest build`, not
# needed in the final image.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

COPY package.json package-lock.json ./

# `--ignore-scripts`: this project's own `prepare` script (`cd .. && husky
# reward-redemption-service/.husky`, package.json) assumes a git working tree one level up — a
# Docker build context has no `.git` at all. `preinstall`'s Node-major-version guard is also
# skipped here, harmlessly: `${NODE_IMAGE}` already pins Node 20 for every stage in this file.
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------------------------
# Stage 2: compile TypeScript → `dist/` against the full dependency set above.
# ---------------------------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.json tsconfig.build.json ./
COPY src src

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
# database. `npm run db:migrate`/`db:rollback` (package.json) already use this exact
# `ts-node -T -r tsconfig-paths/register` invocation locally — this stage reuses the proven
# path, not a new one. `src/database/cli/migrate.ts` does not exist until T-RR-002 — this stage
# is unreachable (and untested) until that task lands, exactly like the migrator stages of both
# sibling services once did before their own first migration task shipped.
# ---------------------------------------------------------------------------------------------
FROM build AS migrator
WORKDIR /app
CMD ["npx", "ts-node", "-T", "-r", "tsconfig-paths/register", "src/database/cli/migrate.ts", "up"]

# ---------------------------------------------------------------------------------------------
# Stage 3: production-only node_modules — none of THIS project's own devDependencies (jest,
# ts-node, typescript, eslint, @nestjs/cli, @nestjs/testing, ...) anywhere in the tree that
# ships. `@types/node` may still show up under `node_modules/@types/node` even with
# `--omit=dev`: it arrives as a legitimate transitive *production* dependency of
# `@grpc/proto-loader` → `protobufjs`, not this project's own devDependency of the same name —
# the same distinction `promo-code-service/Dockerfile`'s own comment draws. Type declarations
# only, harmless either way.
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
# T-INT-041 fix: `.proto` files are static assets `nest build` never copies into `dist/` on its
# own (no `nest-cli.json` `assets` entry existed for this project) — every gRPC client/server this
# service constructs (`campaign-config.client.ts`, `reward-tracking-grpc.client.ts`, the inbound
# `reward-ingest.controller.ts`) loads its `.proto` file via `protobufjs`'s own synchronous
# `fs.readFileSync` at module construction, which throws and crash-loops the whole process before
# `app.listen()` is ever reached if the file isn't here. Confirmed missing and the exact class of
# bug T-INT-005 already found and fixed for reward-tracking-service's own Dockerfile/nest-cli.json.
COPY proto ./proto

USER nodeapp

# `PORT` defaults to 3030 (07-CONFIGURABILITY-AND-OBSERVABILITY.md §1, 04-REST-CONTRACT.md's own
# port-allocation section) and is the only listener this runtime image opens — the gRPC server
# (T-RR-011) and the Kafka consumer (T-RR-012) are each their own standalone bootstrap entry
# point (ARCHITECTURE.md §6, this task's own implementation note 9), compiled into `dist/` by
# this same build but not started by this stage's own CMD below.
EXPOSE 3030

# Node's own `http` client rather than curl/wget: neither ships in `-slim`, and this is a single
# GET with no other dependency. Hits `/health` — this task's own DB-unaware placeholder
# (src/app.controller.ts) today; T-RR-004 supersedes what `/health` actually checks in place,
# without this Dockerfile changing.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3030,path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/main.js"]
