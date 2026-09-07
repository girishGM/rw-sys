import { z } from 'zod';

/**
 * T-RTS-001. The single source of truth for this service's *bootstrap-only* environment
 * variables — the ones that must be resolvable before this service can even open a database
 * connection, since nothing DB-backed can configure the connection to the database itself. Boot
 * fails, loudly and immediately, if anything here is missing or malformed (AGENT-PROTOCOL.md R12 —
 * no default secret in a committed file; a missing `DB_APP_PASSWORD` or `KAFKA_BROKERS` must crash
 * the process with a named error, never start a half-configured service that fails mysteriously on
 * the first real request). Direct port of reward-redemption-service's own
 * `src/config/config.schema.ts` validation approach (zod, already a dependency in that sibling
 * service) — not a new library this repo doesn't already use.
 *
 * Deliberately NOT an exhaustive list of every env var this service will ever read (task
 * implementation note 3 — "Out: any Kafka/gRPC/REST ingestion code (Wave 1)"). `KAFKA_BROKERS` is
 * validated here even though no consumer reads it until T-RTS-012, for the identical reason
 * `GRPC_SERVER_*`/`KAFKA_BROKERS` are pre-validated in every sibling service's own Wave-0 schema —
 * a missing/malformed value fails boot loudly from day one rather than surfacing only once the
 * transport that needs it lands. A later Wave 1+ var that some *other* module reads directly from
 * `process.env` (a bearer token, a downstream client URL) is intentionally NOT folded in here —
 * that would put a later-wave var under a Wave-0 file this task's own agent owns exclusively,
 * silently taking away that later agent's ability to add its own var without touching a file
 * outside its scope.
 */
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3040),

  // --- Database: the `reward_tracking` schema on the EXISTING `reward_system` Postgres 16 server
  // (root CLAUDE.md — /Library/PostgreSQL/16 — do NOT point this at a second, new Postgres
  // instance). Two roles, the same split the portal and every sibling service uses:
  //   DB_APP_*        least-privilege runtime role this service's own code connects as
  //                    (`reward_tracking_app`, T-RTS-002's own migration, scoped to
  //                    `reward_tracking` only — AGENT-PROTOCOL.md R2).
  //   DB_MIGRATION_*  privileged role the migration CLI uses — never imported into request-time
  //                    application code (`migration-connection.ts`, T-RTS-002, reads this
  //                    directly instead of through this schema).
  DB_HOST: z.string().min(1, 'DB_HOST is required'),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().min(1, 'DB_NAME is required'),
  // Deliberately a strict two-value enum, not a loose `value === 'true'` coercion: an
  // out-of-range value (e.g. "maybe") must fail validation at boot with a clear type error, not
  // silently resolve to `false`.
  DB_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  DB_APP_USERNAME: z.string().min(1, 'DB_APP_USERNAME is required'),
  DB_APP_PASSWORD: z.string().min(1, 'DB_APP_PASSWORD is required'),

  DB_MIGRATION_USERNAME: z.string().min(1, 'DB_MIGRATION_USERNAME is required'),
  DB_MIGRATION_PASSWORD: z.string().min(1, 'DB_MIGRATION_PASSWORD is required'),

  // --- Kafka: comma-separated `host:port` broker list for the inbound reward-tracking-dispatch
  // consumer (T-RTS-012) — validated from Wave 0 onward even though no consumer reads it yet, per
  // this file's own header.
  KAFKA_BROKERS: z.string().min(1, 'KAFKA_BROKERS is required'),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Passed as NestJS `ConfigModule.forRoot({ validate })` — runs synchronously during Nest's
 * bootstrap, before any controller, guard or DB connection is ever constructed. On failure it
 * prints every violation (not just the first) and calls `process.exit(1)`, so the process never
 * reaches `app.listen(...)` with a half-configured environment.
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
