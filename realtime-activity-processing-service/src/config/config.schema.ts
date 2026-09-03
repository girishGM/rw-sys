import { z } from 'zod';

/**
 * The single source of truth for required environment variables — boot fails, loudly and
 * immediately, if anything here is missing or malformed (AGENT-PROTOCOL.md R8: "no default
 * secret in a committed file", and this task's own implementation note 3: "a missing
 * DB_PASSWORD or KAFKA_BROKERS at boot must crash the process, not start a half-configured
 * service that fails mysteriously on the first real request"). Every task that introduces a
 * new required secret or connection string extends this schema rather than reading
 * `process.env` directly elsewhere.
 *
 * T-RAP-001 owns NODE_ENV/PORT and the database/Kafka connection shape; later tasks append
 * their own required keys (e.g. field-encryption key material for T-RAP-012, mTLS material
 * for T-RAP-011/T-RAP-022) rather than weakening an existing field's validation.
 */
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3020),

  // --- Database: `realtime_activity_processing` schema on the EXISTING `reward_system`
  // Postgres 16 server (root CLAUDE.md, 01-DATABASE.md "same server, new schema" — this task
  // never stands up a second Postgres instance). Two roles, the same split portal/back-end and
  // promo-code-service already use:
  //   DB_APP_*        the least-privilege runtime role this service's own code connects as
  //                    (`rap_app`, created by T-RAP-002's migration, scoped to the
  //                    `realtime_activity_processing` schema only — AGENT-PROTOCOL.md R1). Not
  //                    created yet by this task; required here purely so a missing value fails
  //                    boot loudly from Wave 0 onward rather than once T-RAP-002 lands.
  //   DB_MIGRATION_*  the privileged role T-RAP-002's migration CLI uses — never imported into
  //                    request-time application code.
  DB_HOST: z.string().min(1, 'DB_HOST is required'),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().min(1, 'DB_NAME is required'),
  DB_SSL: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  DB_APP_USERNAME: z.string().min(1, 'DB_APP_USERNAME is required'),
  DB_APP_PASSWORD: z.string().min(1, 'DB_APP_PASSWORD is required'),

  DB_MIGRATION_USERNAME: z.string().min(1, 'DB_MIGRATION_USERNAME is required'),
  DB_MIGRATION_PASSWORD: z.string().min(1, 'DB_MIGRATION_PASSWORD is required'),

  // --- Kafka: comma-separated `host:port` broker list for this service's own local Redpanda
  // compose target (docker-compose.yml) in dev, or the real cluster elsewhere. T-RAP-023 wires
  // the actual consumer/producer (Wave 2) — required from Wave 0 so a missing broker list fails
  // boot loudly rather than surfacing as a mysterious runtime error only once that task lands
  // (this task's own implementation note 3).
  KAFKA_BROKERS: z.string().min(1, 'KAFKA_BROKERS is required'),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Passed as NestJS `ConfigModule.forRoot({ validate })` — runs synchronously during Nest's
 * bootstrap, before any controller, guard or DB connection is ever constructed. On failure it
 * prints every violation (not just the first) and calls `process.exit(1)`, so the process never
 * reaches `app.listen(...)` with a half-configured environment (TC-4).
 */
export function validateConfig(raw: Record<string, unknown>): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    console.error(`\nInvalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }
  return result.data;
}
