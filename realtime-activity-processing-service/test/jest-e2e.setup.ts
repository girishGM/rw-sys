/**
 * Runs once, before any test file's imports are evaluated (Jest's `setupFiles`, not
 * `beforeAll`). Required because `AppModule` → `ConfigModule` → `NestConfigModule.forRoot`
 * calls `validateConfig()` **synchronously as soon as `config.module.ts` is first imported**
 * (see that file's header) — which, in `test/health.e2e-spec.ts`, happens at the file's static
 * `import { AppModule } from '../src/app.module'` line, before any `beforeAll`/`it` body ever
 * runs. Setting `process.env` inside the spec file itself is too late; promo-code-service's own
 * `test/jest-e2e.setup.ts` (and portal/back-end's own equivalent before it) hit this exact
 * ordering constraint first — this is the same fix, scoped to this project's own required keys.
 *
 * Only sets a default when the key is not already present, so a real `.env.development`/CI
 * environment variable always wins — matching `dotenv.config()`'s own "never overwrite an
 * existing value" behaviour, which those equivalent files rely on for the same reason.
 *
 * `DB_APP_*`/`DB_MIGRATION_*`/`KAFKA_BROKERS` values are never read by anything this task
 * builds (Kafka wiring is Wave 2; the DB roles don't exist until T-RAP-002's migration) — only
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
setDefault('DB_APP_USERNAME', 'rap_app');
setDefault('DB_APP_PASSWORD', 'throwaway-local-dev-value');
setDefault('DB_MIGRATION_USERNAME', 'postgres');
setDefault('DB_MIGRATION_PASSWORD', 'throwaway-local-dev-value');
setDefault('KAFKA_BROKERS', 'localhost:9093');
