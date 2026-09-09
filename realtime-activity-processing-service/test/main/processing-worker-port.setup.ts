/**
 * T-INT-043. Must be `processing-worker.e2e-spec.ts`'s own FIRST import (before `@/main`, before
 * `reflect-metadata`, before anything else) — works around a real, pre-existing quirk of
 * `@nestjs/config`'s own `ConfigModule.forRoot()`
 * (`node_modules/@nestjs/config/dist/config.module.js`'s `static async forRoot()`): the validated
 * config object it produces (including `PORT`, `src/config/config.schema.ts`'s own
 * `z.coerce.number()...default(3020)` field) is computed exactly ONCE per Node process,
 * synchronously, the FIRST time `src/config/config.module.ts` is imported — never re-read fresh on
 * a later `NestFactory.create(AppModule)` call in that same process. By that first-import moment,
 * `process.env.PORT` is already `'3020'` (`.env.development`'s own default, loaded by the global
 * Jest `setupFiles` entry `test/database/env.setup.ts` before ANY test file's own imports run), so
 * a later, per-test `process.env.PORT = String(await getFreePort())` assignment inside a test body
 * (`hybrid-bootstrap.e2e-spec.ts`'s own `resetEnvToBaseline()` pattern, this file's own earlier
 * draft included) is silently ineffective for this one config field specifically — confirmed live
 * while building this task: both `test/main/hybrid-bootstrap.e2e-spec.ts` (T-INT-003, a
 * pre-existing file this task does not own or modify) and this file's own earlier draft always
 * really bound to the literal port 3020 underneath, regardless of what a test body assigned. This
 * was invisible before T-INT-043 because no two test files previously called
 * `startHybridBootstrap()`'s real `app.listen(port)` concurrently, in two different OS processes —
 * `hybrid-bootstrap.e2e-spec.ts`'s own 6 tests run sequentially in ONE process/file, so they never
 * collided with each other on that shared frozen port. This file is the first second real caller,
 * so it needs its own distinct, equally-frozen port instead of a per-test override that provably
 * does not work for this one field — flagged for the architect as a real, pre-existing gap in
 * `hybrid-bootstrap.e2e-spec.ts`'s own `resetEnvToBaseline()` (T-INT-003's own file, out of this
 * task's Files-owned scope to fix directly) in this task's own completion report.
 *
 * `3029` — distinct from `hybrid-bootstrap.e2e-spec.ts`'s own permanently-frozen `3020`, and from
 * every other fixed port this service's own `.env.example` documents (`50071` gRPC, `3021`
 * progress API).
 */
process.env.PORT = '3029';
