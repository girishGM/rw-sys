/**
 * Runs once, before any test file's imports are evaluated (Jest's `setupFiles`, not
 * `beforeAll`). Required because `AppModule` → `ConfigModule` → `NestConfigModule.forRoot`
 * calls `validateConfig()` **synchronously as soon as `config.module.ts` is first imported**
 * (see that file's header) — which, in `test/health.e2e-spec.ts`, happens at the file's
 * static `import { AppModule } from '../src/app.module'` line, before any `beforeAll`/`it`
 * body ever runs. Setting `process.env` inside the spec file itself is too late; portal/
 * back-end's own `test/jest-e2e.setup.ts` hit this exact ordering constraint first (see that
 * file's own header) — this is the same fix, scoped to this project's own required keys.
 *
 * Only sets a default when the key is not already present, so a real `.env.development`/CI
 * environment variable always wins — matching `dotenv.config()`'s own "never overwrite an
 * existing value" behaviour, which portal's equivalent file relies on for the same reason.
 *
 * `DB_APP_*`/`DB_MIGRATION_*`/`KAFKA_BROKERS` values are never read by anything this task
 * builds (Kafka wiring is Wave 3; the DB roles don't exist until T-PC-002's migration) — only
 * `DB_HOST`/`DB_PORT` matter to the `/health` endpoint this task ships, and those two point at
 * the real, already-running local Postgres 16 server documented in root `CLAUDE.md`.
 */
function setDefault(key: string, value: string): void {
  if (process.env[key] === undefined || process.env[key] === '') {
    process.env[key] = value;
  }
}

setDefault('NODE_ENV', 'test');
setDefault('DB_HOST', '127.0.0.1');
setDefault('DB_PORT', '5432');
setDefault('DB_NAME', 'reward_system');
setDefault('DB_APP_USERNAME', 'promo_code_app');
setDefault('DB_APP_PASSWORD', 'throwaway-local-dev-value');
setDefault('DB_MIGRATION_USERNAME', 'postgres');
setDefault('DB_MIGRATION_PASSWORD', 'throwaway-local-dev-value');
setDefault('KAFKA_BROKERS', 'localhost:9092');
// T-PC-011: throwaway default so a real `.env.development`/CI value always wins (same
// `setDefault` convention as every other key above); exercised directly by
// `promo-code-config.e2e-spec.ts`'s valid-token requests.
setDefault('INTERNAL_SERVICE_TOKEN', 'test-internal-service-token');
// T-PC-056: a deliberately *different* throwaway value from `INTERNAL_SERVICE_TOKEN` above (R11 —
// the two secrets must never be interchangeable, exercised directly by
// `promo-code-generate.controller.spec.ts`'s TC-4). Same "real env always wins" `setDefault`
// convention. This append (like `GenerationModule`'s own registration in `app.module.ts`) follows
// the precedent `INTERNAL_SERVICE_TOKEN` above already set for a file outside the literal
// `project.config.json` grant of the task that needs it — see that task's completion report.
setDefault('GENERATION_SERVICE_TOKEN', 'test-generation-service-token');
