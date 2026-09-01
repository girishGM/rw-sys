# syntax=docker/dockerfile:1
#
# T-PC-050 — the promo-code-service image. Multi-stage, non-root, no dev dependencies or source
# maps in the final layer, HEALTHCHECK against `GET /health` (src/health/health.controller.ts,
# T-PC-001 — process liveness + a raw TCP probe of DB_HOST/DB_PORT, deliberately not an
# authenticated query; see that file's own header for why. Liveness only, same reasoning
# `portal/back-end/Dockerfile`'s own header gives for its `/api/v1/health`: a slow-starting or
# temporarily unreachable Postgres must not flap-restart this container).
#
# Mirrors `portal/back-end/Dockerfile`'s stage structure (deps → build → migrator → prod-deps →
# runtime), simplified because this is a standalone, single-package project — no npm workspace,
# no `packages/shared`, no second (front-end) image to build alongside it. Built from THIS
# directory (`promo-code-service/`), not the repo root — see `render.yaml`'s own
# `dockerContext`/`rootDir`.
#
# `node:20-bookworm-slim`, matching the portal's own choice and root CLAUDE.md's Node 20
# requirement (`package.json`'s own `engines`/`preinstall` check already enforce this for local
# dev) — no reason to diverge, and it keeps this service debuggable with the exact same base
# image as the portal if the two are ever compared side by side.

ARG NODE_IMAGE=node:20-bookworm-slim

# ---------------------------------------------------------------------------------------------
# Stage 1: install every dependency, including dev — needed to run `tsc`/`nest build`, not
# needed in the final image.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

COPY package.json package-lock.json ./

# `--ignore-scripts`: this project's own `prepare` script (`cd .. && husky
# promo-code-service/.husky`, package.json) assumes a git working tree one level up (the exact
# same reason `portal/back-end/Dockerfile` documents for its own root `prepare` script) — a
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
 # TC-4 (mirrors portal Dockerfile's own TC-15): no source maps of server code in the final
 # image. `sourceMap: true` (tsconfig.json) is correct for local debugging; stripping the
 # emitted `.map` files here — after the build that needed them, before the copy that ships
 # them — keeps that setting rather than weakening it for every other environment.
 && find dist -name '*.map' -delete

# ---------------------------------------------------------------------------------------------
# Stage 2a: the one-off migration job — never shipped as part of the `runtime` stage below, and
# not reachable by building this file without naming the target (`--target migrator`, TC-3).
#
# Runs `src/database/cli/migrate.ts` via `ts-node` against the *source*, deliberately not
# `node dist/database/cli/migrate.js` against the compiled output — exactly the same reason
# `portal/back-end/Dockerfile`'s own `migrator` stage gives (umzug's migration glob is written
# against `.ts` filenames and would silently discover zero migrations against compiled `.js`
# output, reporting "Applied 0 migration(s)" indistinguishably from a genuinely up-to-date
# database). `npm run db:migrate`/`db:rollback` (package.json) already use this exact
# `ts-node -T -r tsconfig-paths/register` invocation locally — this stage reuses the proven path,
# not a new one. The dev dependencies it needs (`ts-node`, `typescript`, `tsconfig-paths`) are
# fine here precisely because this stage is never part of the shipped `runtime` image TC-4
# governs — `FROM build`, not `FROM runtime`.
# ---------------------------------------------------------------------------------------------
FROM build AS migrator
WORKDIR /app
CMD ["npx", "ts-node", "-T", "-r", "tsconfig-paths/register", "src/database/cli/migrate.ts", "up"]

# ---------------------------------------------------------------------------------------------
# Stage 3: production-only node_modules — none of THIS project's own devDependencies (jest,
# ts-node, typescript, eslint, @nestjs/cli, @nestjs/testing, ...) anywhere in the tree that ships
# (TC-4). `@types/node` is the one exception worth calling out explicitly if you go looking: it
# still shows up under `node_modules/@types/node` even with `--omit=dev`, but it arrives as a
# transitive *production* dependency of `@grpc/proto-loader` → `protobufjs` (verify with `npm ls
# @types/node --all`), not as this project's own devDependency of the same name — the exact same
# "legitimate transitive prod dependency, not devDependency bleed" distinction
# `portal/back-end/Dockerfile`'s own TC-15 comment draws for `luxon`/`moment`. It's type
# declarations only (no runtime code executed from it), so it's harmless either way.
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

# A dedicated, unprivileged user (TC-5) — never the image's default root.
RUN groupadd --gid 1001 nodeapp \
 && useradd --uid 1001 --gid nodeapp --shell /usr/sbin/nologin --no-create-home nodeapp

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

USER nodeapp

# `PORT` (src/config/config.schema.ts, T-PC-001) defaults to 3010 and is the only listener this
# runtime image opens — the gRPC server (src/grpc/grpc-server.main.ts, its own `GRPC_PORT`,
# default 50061, T-PC-031) and the Kafka consumer (src/messaging/kafka-consumer.main.ts,
# T-PC-030) are separate standalone entry points this stage compiles into `dist/` but does not
# start; see this task's own completion report ("Deviations from spec") for why they are out of
# scope here.
EXPOSE 3010

# Node's own `http` client rather than curl/wget: neither ships in `-slim`, and this is a single
# GET with no other dependency. Hits `/health` (liveness + DB-reachability only, see this file's
# header) — no `/health/ready`-style endpoint exists in this service (health.controller.ts), so
# there is only the one path to check, unlike the portal's own two-tier design.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3010,path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/main.js"]
