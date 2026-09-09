import { z } from 'zod';

/**
 * T-RR-004. The single source of truth for this service's *bootstrap-only* environment
 * variables — the ones that must be resolvable before this service can even open a database
 * connection, since nothing DB-backed can configure the connection to the database itself
 * (`07-CONFIGURABILITY-AND-OBSERVABILITY.md` §1, `ARCHITECTURE.md` §4's config-precedence row).
 * Boot fails, loudly and immediately, if anything here is missing or malformed
 * (AGENT-PROTOCOL.md R1 — no default secret in a committed file; a missing `DB_APP_PASSWORD` or
 * `KAFKA_BROKERS` must crash the process with a named error, never start a half-configured
 * service that fails mysteriously on the first real request). This is a direct port of RAP's own
 * `src/config/config.schema.ts` validation approach (zod, already a dependency here) — not a new
 * library this repo doesn't already use.
 *
 * Deliberately NOT an exhaustive list of every env var this service will ever read
 * (T-RR-004 implementation note 2). `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §1's own table
 * splits vars into what this schema validates (DB connection, listen ports, Kafka broker string,
 * inbound gRPC server mTLS material) versus what a later, differently-owned module reads
 * directly from `process.env` itself: `FIELD_ENCRYPTION_*` (T-RR-005), the three bearer tokens
 * (Wave 1/3), and the `PORTAL_GRPC_*` client vars (T-RR-022). Folding those in here would put a
 * later-wave var under a Wave-0 file this task's own agent owns exclusively, silently taking
 * away that later task's ability to add its own var without touching a file outside its scope.
 * See `.env.example`'s own documented boundary line for the full list of what's excluded and why.
 */
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3030),

  // --- Inbound gRPC ingestion server (T-RR-011, `RewardIngestService.SubmitRewardEntry`) —
  // listen port + mTLS material validated here even though the server itself isn't wired up
  // until Wave 1, so a missing/malformed value fails boot loudly from Wave 0 onward rather than
  // surfacing only once T-RR-011 lands (the same reasoning already applied below to
  // `KAFKA_BROKERS`, which T-RR-012 doesn't wire until Wave 1 either).
  GRPC_SERVER_PORT: z.coerce.number().int().positive().default(50081),
  GRPC_SERVER_TLS_CA_PATH: z.string().min(1, 'GRPC_SERVER_TLS_CA_PATH is required'),
  GRPC_SERVER_TLS_CERT_PATH: z.string().min(1, 'GRPC_SERVER_TLS_CERT_PATH is required'),
  GRPC_SERVER_TLS_KEY_PATH: z.string().min(1, 'GRPC_SERVER_TLS_KEY_PATH is required'),
  GRPC_SERVER_ALLOWED_IDENTITIES: z.string().min(1, 'GRPC_SERVER_ALLOWED_IDENTITIES is required'),

  // --- Database: the `reward_redemption` schema on the EXISTING `reward_system` Postgres 16
  // server (root CLAUDE.md — /Library/PostgreSQL/16 — do NOT point this at a second, new
  // Postgres instance). Two roles, the same split the portal and both sibling services use:
  //   DB_APP_*        least-privilege runtime role this service's own code connects as
  //                    (`rr_app`, T-RR-003's own migration, scoped to `reward_redemption` only —
  //                    AGENT-PROTOCOL.md R5).
  //   DB_MIGRATION_*  privileged role the migration CLI uses — never imported into request-time
  //                    application code (`migration-connection.ts` reads this directly instead
  //                    of through this schema; see that file's own header for why).
  DB_HOST: z.string().min(1, 'DB_HOST is required'),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().min(1, 'DB_NAME is required'),
  // Deliberately a strict two-value enum, not a loose `value === 'true'` coercion: TC-2 requires
  // an out-of-range value (e.g. "maybe") to fail validation at boot with a clear type error, not
  // silently resolve to `false`.
  DB_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  DB_APP_USERNAME: z.string().min(1, 'DB_APP_USERNAME is required'),
  DB_APP_PASSWORD: z.string().min(1, 'DB_APP_PASSWORD is required'),

  DB_MIGRATION_USERNAME: z.string().min(1, 'DB_MIGRATION_USERNAME is required'),
  DB_MIGRATION_PASSWORD: z.string().min(1, 'DB_MIGRATION_PASSWORD is required'),

  // --- Kafka: comma-separated `host:port` broker list, for both the inbound
  // `reward.entry.created.v1` consumer (T-RR-012) and the outbound
  // `reward.redemption.completed.v1` producer (T-RR-034) — `ARCHITECTURE.md` §9.
  KAFKA_BROKERS: z.string().min(1, 'KAFKA_BROKERS is required'),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Passed as NestJS `ConfigModule.forRoot({ validate })` — runs synchronously during Nest's
 * bootstrap, before any controller, guard or DB connection is ever constructed. On failure it
 * prints every violation (not just the first) and calls `process.exit(1)`, so the process never
 * reaches `app.listen(...)` with a half-configured environment (TC-1/TC-2).
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
