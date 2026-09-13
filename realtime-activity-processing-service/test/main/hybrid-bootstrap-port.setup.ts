/**
 * T-INT-062 retry 3. Must be `hybrid-bootstrap.e2e-spec.ts`'s own FIRST import (before
 * `reflect-metadata`, before anything else) — the exact same real, pre-existing `@nestjs/config`
 * quirk `processing-worker-port.setup.ts` already documents and fixes for its own sibling file,
 * now root-caused and fixed here too.
 *
 * **What retry 2's own report got wrong, and what this retry actually found.** Retry 2's
 * completion report treated every `EADDRINUSE :::3020`/"wrong exception type on TC-6/TC-8" failure
 * an independent review reproduced as ordinary, load-driven flakiness in the primary
 * `app.listen(port)` call — real, but supposedly rare and out of this task's scope to fix
 * (Deviations #1: "doing so would mean adding retry logic around `startHybridBootstrap()`'s own
 * foundational, always-on `app.listen()` call"). **That diagnosis was incomplete.** The actual
 * mechanism is structural, not a rare race: `NestConfigModule.forRoot({ validate: validateConfig })`
 * (`src/config/config.module.ts`) is called inside a `@Module({ imports: [...] })` decorator's own
 * `imports` array — an expression evaluated **synchronously, at class-definition time**, i.e. the
 * moment `config.module.ts` is first imported (here: transitively, via this spec file's own
 * `import { startHybridBootstrap, ... } from '@/main'` at the top of the file, which runs before
 * ANY test body, including this file's own `resetEnvToBaseline()`, ever executes). Reading
 * `node_modules/@nestjs/config/dist/config.module.js`'s own `static async forRoot()` directly
 * confirms the synchronous prefix of that function (`config = { ...config, ...process.env }` then
 * `options.validate(config)` then `this.assignVariablesToProcess(validatedConfig)`) runs entirely
 * before its first `await` — so `PORT` is read from `process.env` and permanently baked into this
 * file's own validated config **once, at import time**, before `resetEnvToBaseline()`'s own
 * `process.env.PORT = String(await getFreePort())` line (every prior retry's attempted "give each
 * test a fresh, free port" mechanism) ever has a chance to run. Every one of this file's own 8
 * tests was therefore, contrary to this file's own long-standing header comments, actually binding
 * `startHybridBootstrap()`'s primary `app.listen(port)` call to the SAME single, frozen port for
 * the entire file's run — literal port `3020` (`.env.development`'s own default, loaded by the
 * global Jest `setupFiles` entry `test/database/env.setup.ts` before this file's own imports run),
 * unless some earlier file in the same Jest worker process happened to leave `process.env.PORT` at
 * a different value first. This is the direct, provable root cause of the independent review's own
 * reproduced failures: a real, separately-running process (another concurrently-scheduled Jest
 * worker's own file, or a real local `npm run start:dev` instance — this project's own `CLAUDE.md`
 * documents this exact machine routinely running several dev/orchestrator processes at once)
 * genuinely holding port `3020` collides with this file's own `app.listen(3020)` call. **TC-6/TC-8's
 * own "wrong exception type" failure is the same root cause, not a separate defect**: the primary
 * `app.listen(port)` call is not wrapped by `attemptOptionalTransport`'s try/catch (by design — see
 * `src/main.ts`'s own header) — when THAT call itself throws `EADDRINUSE`, `startHybridBootstrap()`
 * never even reaches the gRPC-transport attempt those two tests exist to exercise, so it rejects
 * with a raw `Error`, not the `HybridBootstrapError` both tests assert `instanceof` against.
 *
 * **The fix, mirroring `processing-worker-port.setup.ts`'s own already-proven precedent for the
 * identical quirk**: pin `PORT` to a dedicated, fixed value — `3033`, distinct from `3020` (the
 * `.env.development` default every OTHER un-pinned file freezes to), `3029`
 * (`processing-worker-port.setup.ts`'s own pin), `50071` (gRPC), and `3021` (progress API,
 * `.env.example`) — BEFORE `@/main` (and therefore `config.module.ts`) is ever imported by this
 * file. This does not need to be "fresh per test": exactly like `processing-worker.e2e-spec.ts`'s
 * own single fixed port already works safely for its own multiple sequential tests,
 * `hybrid-bootstrap.e2e-spec.ts`'s own 8 tests already run strictly sequentially within one file
 * and each one's own `finally` block closes `httpApp` (freeing the port) before the next test's own
 * `app.listen()` call — a fixed port was always safe FOR THIS FILE's own internal sequencing; the
 * missing piece was only ever avoiding collision with something OUTSIDE this file, which a fixed,
 * literal, not-the-default port number provides just as well as a "fresh" one would have, without
 * depending on a per-test env reassignment that this `@nestjs/config` quirk was silently discarding
 * anyway.
 */
process.env.PORT = '3033';
